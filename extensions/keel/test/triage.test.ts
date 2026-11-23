import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaneEvent, Message, World } from "../src/kernel/lane.ts";
import { queueLane } from "../src/lanes/queue/index.ts";
import { explorerDispatch } from "../src/roles/dispatch.ts";
import { laneDriver } from "./fixtures/drive.ts";

const plan = [
	{
		id: "ledger",
		goal: "Compare both ledger balances",
		stage: "building",
		nodes: ["sums"],
		deps: [],
	},
];
const activeWorld: World = {
	work: null,
	root: "/checkout",
	now: 1,
	options: {
		build: "x/a",
		verify: "x/b",
		design: "x/c",
		queue: "x/d",
		max_workers: 2,
		base: "main",
		trunk: "trunk",
	},
	view: (lane) =>
		lane === "build"
			? { phase: "active", plan }
			: {
					mandate: {
						intent: "Post each cent once.",
						nodes: [
							{
								label: "sums",
								rule: "Round once.",
								probe: "Post a half-cent.",
							},
							{
								label: "totals",
								rule: "Totals include reversed postings.",
								probe: "Reverse a posting.",
							},
						],
						checks: [],
						delegated: [],
						considerations: null,
					},
				},
};
const filing = {
	kind: "intake",
	work: 4,
	source: "worker",
	item: "ledger",
	sha: "commit-one",
	text: "Which rounding boundary?",
	report: "The two calculations disagree by 1.",
	nodes: ["sums"],
	edgeCase: null,
	pattern: null,
	blocking: false,
};
function queue(world: World = activeWorld) {
	return queueLane.use((l) => {
		const driver = laneDriver(l, world);
		const send = (e: LaneEvent): Message[] => {
			const r = driver.send(e);
			const outgoing = (r.send ?? []).filter((m) => {
				if (
					m.lane !== "queue" ||
					!["begin_investigation", "intake"].includes(m.event.kind)
				)
					return true;
				send(m.event);
				return false;
			});
			return outgoing;
		};
		const file = (over: Partial<LaneEvent> = {}) =>
			send({ ...filing, ...over } as LaneEvent);
		const investigation = (
			finding = 1,
			classification = "determined",
			extra: Omit<LaneEvent, "kind"> = {},
		) => ({
			kind: "investigated",
			finding,
			classification,
			evidence: "Compared both totals at the posting boundary.",
			size: "small",
			cause: "rounding point",
			recommendation: "build",
			reference: "signed spec",
			sameAs: null,
			nodes: ["sums"],
			...extra,
		});
		const ask = driver.asks;
		const answer = (choice: string, subject = ask()[0]!.subject) =>
			send({
				kind: "answered",
				subject,
				choice,
				decision: "d1",
				annotations: [{ n: 1, text: "Use the ledger boundary." }],
			});
		return {
			send,
			file,
			attempt: driver.attempt,
			investigation,
			classify: (...args: Parameters<typeof investigation>) =>
				send(investigation(...args)),
			ask,
			answer,
			agents: driver.agents,
			effects: driver.effects,
			view: () =>
				driver.view() as {
					findingsFor(work: number): string;
					patternRulings: { name: string; status: string }[];
					priorFindings: {
						text: string;
						report: string | null;
						disposition: string;
					}[];
				},
		};
	});
}

test("an investigator cannot close a project finding as no action", () => {
	const q = queue();
	q.file({ source: "sweeper", work: null, item: null });
	const result = q.attempt(
		q.investigation(1, "no_action", { nodes: [], recommendation: "no_action" }),
	);
	assert.match("reject" in result ? result.reject : "", /work/);
	const turn = q.agents()[0]!.expect;
	assert.match(turn!.input!(), /project finding[\s\S]*no_action/);
	q.classify(1, "sets_precedent", { nodes: [] });
	assert.equal(q.ask().length, 1);
});

test("sweep history carries dropped and deferred drift evidence, not ordinary findings", () => {
	const q = queue();
	q.file({ source: "owner", text: "Ordinary owner finding" });
	q.classify(1);
	q.answer("defer");
	for (const [i, disposition] of ["drop", "defer"].entries()) {
		q.file({
			source: "sweeper",
			work: null,
			text: `Drift ${i}`,
			report: `Evidence ${i}`,
		});
		q.classify(i + 2, "sets_precedent", { nodes: [] });
		q.answer(disposition);
	}
	assert.deepEqual(
		q.view().priorFindings.map((f) => [f.text, f.report, f.disposition]),
		[
			["Drift 0", "Evidence 0", "dropped"],
			["Drift 1", "Evidence 1", "deferred"],
		],
	);
});

test("a sweep files a project defect or reference mismatch without a hold; build seeds new work", () => {
	for (const classification of ["defect_in_scope", "mandate_wrong"]) {
		const q = queue({ ...activeWorld, view: () => null });
		assert.deepEqual(
			q.file({
				source: "sweeper",
				work: null,
				item: null,
				text: "The playbook calls a removed command.",
			}),
			[],
		);
		assert.deepEqual(q.classify(1, classification, { nodes: [] }), []);
		assert.match(q.ask()[0]!.basis, /The playbook calls a removed command/);
		const [seed] = q.answer("build");
		assert.equal(seed?.work, "new");
		assert.equal(seed?.event.kind, "queue_seed");
	}
});

test("a sweep is opt-in; failed ticks re-arm and only the current tick may file principle evidence", () => {
	const q = queue({
		...activeWorld,
		options: { ...activeWorld.options, sweep_minutes: 1 },
	});
	assert.deepEqual(q.effects(), []);
	q.send({ kind: "sweep_configured" });
	const [failed] = q.effects();
	assert.equal(failed?.interruptible, true);
	assert.equal(failed?.delayMs, 60_000);
	assert.deepEqual(
		q.send({
			kind: "effect_failed",
			key: failed!.key,
			error: "Could not inspect trunk",
		}),
		[],
	);
	const [current] = q.effects();
	assert.notEqual(current!.key, failed!.key);
	q.send({ kind: "sweep_configured" });
	assert.equal(
		q.effects()[0]?.key,
		current!.key,
		"unchanged configuration does not rearm",
	);

	const result = {
		findings: [
			{
				text: "Bind project/round-once to ledger work",
				report: "Pulled on 9 of 10 landed items",
				principle: true,
			},
		],
	};
	q.send({ kind: "effect_done", key: failed!.key, result });
	assert.deepEqual(q.agents(), []);
	q.send({ kind: "effect_done", key: current!.key, result });
	const unsuitable = q.attempt(
		q.investigation(1, "defect_in_scope", { nodes: [] }),
	);
	assert.match(
		"reject" in unsuitable ? unsuitable.reject : "",
		/principle proposal.*sets_precedent/,
	);
	assert.deepEqual(q.classify(1, "sets_precedent", { nodes: [] }), []);
	assert.match(q.ask()[0]!.basis, /Bind project\/round-once[\s\S]*9 of 10/);
	assert.deepEqual(q.answer("drop"), []);
});

test("an unlikely edge case without likelihood and a blocking filing without an own item are refused", () => {
	const q = queue();
	for (const over of [
		{
			edgeCase: {
				failure: "overflow",
				likelihood: " ",
				cost: "second representation",
			},
		},
		{ source: "owner", blocking: true, item: null },
	])
		assert.ok("reject" in q.attempt({ ...filing, ...over }));
	assert.deepEqual(q.agents(), []);
	assert.ok(
		"reject" in
			q.attempt({
				...filing,
				blocking: true,
				edgeCase: { failure: "overflow", likelihood: "rare", cost: "new type" },
			}),
	);
});
test("drop and defer release the original hold after classification expands its scope", () => {
	for (const choice of ["drop", "defer"]) {
		const q = queue();
		const [own] = q.file({ blocking: true });
		assert.deepEqual(
			[
				own?.lane,
				own?.work,
				own?.event.kind,
				own?.event.item,
				own?.event.nodes,
			],
			["build", 4, "queue_hold", "ledger", []],
		);
		const [nodes] = q.classify(1, "mandate_wrong");
		assert.deepEqual(
			[nodes?.event.kind, nodes?.event.nodes, nodes?.event.cause],
			["queue_hold", ["sums"], own?.event.cause],
		);
		const subject = q.ask()[0]!.subject;
		const [release] = q.answer(choice);
		assert.deepEqual(
			[release?.lane, release?.event.kind, release?.event.cause],
			["build", "queue_release", own?.event.cause],
		);
		assert.match(String(release?.event.direction), /Use the ledger boundary/);
		assert.deepEqual(q.answer("build", subject), []);
		assert.match(
			q.view().findingsFor(4),
			choice === "drop" ? /dropped/ : /deferred/,
		);
	}
});
test("links through another finding replace only their own decision and retain the full batch", () => {
	const q = queue();
	const reports = [
		"First discrepancy",
		"Unclear flag",
		"Another discrepancy",
		"Third discrepancy",
	];
	for (const text of reports) q.file({ text });
	q.classify(1, "sets_precedent");
	q.classify(2, "sets_precedent", { cause: "flag semantics" });
	const [first, unrelated] = q.ask();
	const next = q.agents()[0]!.expect!.input!();
	assert.match(next, /#1.*triage.*sets_precedent.*rounding point/);
	assert.match(next, /#2.*triage.*sets_precedent.*flag semantics/);
	q.classify(3, "sets_precedent", { sameAs: 1, cause: "" });
	q.classify(4, "sets_precedent", { sameAs: 3 });
	const [combined, separate] = q.ask();
	assert.equal(q.ask().length, 2);
	assert.deepEqual(separate, unrelated);
	assert.notEqual(combined!.basis, first!.basis);
	const batch =
		/First discrepancy[\s\S]+Another discrepancy[\s\S]+Third discrepancy/;
	assert.match(combined!.basis, batch);
	const [seed] = q.answer("build", combined!.subject);
	assert.equal(seed?.work, "new");
	assert.match(String(seed?.event.text), batch);
	assert.match(String(seed?.event.text), /Use the ledger boundary/);
	assert.doesNotMatch(String(seed?.event.text), /Unclear flag/);
	assert.deepEqual(q.ask(), [unrelated]);
});

test("linking cannot reuse a different classification, authority, or destination", () => {
	for (const [classification, file, target, report] of [
		["determined", {}, "sets_precedent", {}],
		["determined", {}, "determined", { reference: "another spec" }],
		["determined", { work: 5 }, "determined", {}],
		["mandate_wrong", { work: 5 }, "mandate_wrong", {}],
		["defect_in_scope", { work: 5, blocking: true }, "defect_in_scope", {}],
	] as const) {
		const q = queue();
		q.file();
		q.classify(1, classification);
		q.file({ text: "Other discrepancy", ...file });
		const link = q.attempt(
			q.investigation(2, target, { sameAs: 1, ...report }),
		);
		assert.match(
			"reject" in link ? link.reject : "",
			classification === "defect_in_scope"
				? /same in-scope defect in this build/
				: /same decision, authority and destination/,
		);
	}
});

test("a link to a decided reference needs a new answer and cannot release the new filer", () => {
	for (const [choice, disposition] of [
		["drop", "dropped"],
		["defer", "deferred"],
		["build", "build"],
	]) {
		const q = queue();
		q.file();
		q.classify();
		const previous = q.ask()[0]!.subject;
		q.answer(choice!);
		q.file({ text: "Same cause after the answer", blocking: true });
		assert.deepEqual(q.classify(2, "determined", { sameAs: 1, cause: "" }), []);
		const next = q.ask()[0]!;
		assert.notEqual(next.subject, previous);
		assert.match(next.basis, /Finding #2: Same cause after the answer/);
		assert.match(
			next.basis,
			new RegExp(`#1[^\\n]+Which rounding boundary[^\\n]+${disposition}`),
		);
		assert.deepEqual(q.answer("build", previous), []);
		assert.equal(
			q.answer("build", next.subject)[0]?.event.kind,
			"plan_finding",
		);
	}
});

test("linking to a wrong-Mandate finding after build never joins its prior revision, pending or applied", () => {
	for (const applied of [false, true]) {
		const q = queue();
		q.file();
		q.classify(1, "mandate_wrong");
		q.answer("build");
		if (applied)
			q.send({
				kind: "revision_disposition",
				work: 4,
				causes: ["queue/1"],
				disposition: "revision applied (sums)",
			});
		q.file({
			text: "The revised framing still loses the prefix",
			blocking: true,
		});
		const messages = q.classify(2, "mandate_wrong", { sameAs: 1 });
		assert.ok(messages.every((m) => m.event.kind === "queue_hold"));
		const next = q.ask()[0]!;
		assert.match(next.basis, /The revised framing still loses the prefix/);
		assert.match(next.basis, /#1[^\n]+Which rounding boundary/);
		assert.match(next.basis, /(?:awaiting Mandate revision|revision applied)/);
		assert.deepEqual(
			q.answer("build").find((m) => m.event.kind === "revise_mandate")?.event
				.causes,
			["queue/2"],
		);
	}
});

test("an identical re-filing after defer is investigated once and can reopen the original", () => {
	const q = queue();
	q.file();
	q.classify();
	const first = q.ask()[0]!.subject;
	q.answer("defer");
	q.file();
	q.file();
	assert.match(
		q.agents()[0]?.expect?.input?.() ?? "",
		/Investigate finding #2/,
	);
	q.classify(2, "determined", { sameAs: 1, cause: "" });
	assert.notEqual(q.ask()[0]?.subject, first);
	assert.equal(q.agents()[0]?.expect, null);
});

test("the investigator can close a non-blocking observation with a reason but not a blocked filer or the owner's finding", () => {
	const q = queue();
	q.file({ source: "verifier", text: "Other readers unchanged" });
	q.file({
		source: "owner",
		text: "The landed change does not handle an empty book.",
	});
	q.file({ text: "I am blocked", blocking: true });
	const closure = {
		recommendation: "no_action",
		evidence: "The observations match the bound rule.",
		nodes: [],
	};
	assert.deepEqual(q.classify(1, "no_action", closure), []);
	assert.deepEqual(q.ask(), []);
	assert.match(
		q.view().findingsFor(4),
		/no action: The observations match the bound rule/,
	);
	assert.ok("reject" in q.attempt(q.investigation(2, "no_action", closure)));
	q.classify(2, "sets_precedent");
	assert.ok("reject" in q.attempt(q.investigation(3, "no_action", closure)));
});

test("a no-action closure after hand-over was written sends its reason to that work", () => {
	let landed: string | null = null;
	const q = queue({
		...activeWorld,
		view: (lane) => (lane === "verify" ? { landed } : activeWorld.view(lane)),
	});
	q.file({ source: "verifier", text: "Late verifier observation" });
	assert.match(
		q.view().findingsFor(4),
		/Late verifier observation \(open: awaiting investigation\)/,
	);
	landed = "landed-commit";
	const [note] = q.classify(1, "no_action", {
		recommendation: "no_action",
		nodes: [],
		evidence: "The format already requires an empty line.",
	});
	assert.equal(note?.work, 4);
	assert.match(
		JSON.stringify(note?.event),
		/Late verifier observation[^\n]+The format already requires an empty line/,
	);
	assert.deepEqual(q.ask(), []);
});

test("a wrong Mandate discovered after handoff remains visible without holding landing", () => {
	let phase = "active";
	const q = queue({
		...activeWorld,
		view: (lane) =>
			lane === "build" ? { phase, plan } : activeWorld.view(lane),
	});
	q.file({ source: "verifier", item: null });
	phase = "handed_off";
	assert.deepEqual(q.classify(1, "mandate_wrong"), []);
	assert.match(q.ask()[0]!.basis, /Round once/);
	assert.match(q.ask()[0]!.basis, /does not hold.*landing/i);
	assert.equal(q.answer("build")[0]?.work, "new");
});

test("hand-over evidence for the work includes dispositions and open findings but not other work", () => {
	const q = queue();
	q.file({ text: "Closed as an observation" });
	q.classify(1, "no_action", {
		recommendation: "no_action",
		nodes: [],
		evidence: "Nothing needs editing.",
	});
	q.file({ text: "Deferred concern" });
	q.classify(2);
	q.answer("defer");
	q.file({ text: "Settled rounding boundary" });
	q.classify(3, "mandate_wrong");
	q.answer("build");
	q.send({
		kind: "revision_disposition",
		work: 4,
		causes: ["queue/3"],
		disposition: "already settled by sums",
	});
	q.file({ text: "Still under investigation" });
	q.file({ work: 5, text: "Different work entirely" });
	const report = q.view().findingsFor(4);
	assert.match(
		report,
		/Closed as an observation[^\n]+no action[^\n]+Nothing needs editing/,
	);
	assert.match(report, /Deferred concern[^\n]+deferred/);
	assert.match(
		report,
		/Settled rounding boundary[^\n]+already settled by sums/,
	);
	assert.match(report, /Still under investigation[^\n]+open/);
	assert.doesNotMatch(report, /Different work entirely/);
});

test("an unlikely edge case holds nothing until the owner answers build on a wrong-Mandate finding", () => {
	const q = queue();
	assert.deepEqual(
		q.file({
			edgeCase: {
				failure: "Cent lost",
				likelihood: "Unsupported import",
				cost: "Format change",
			},
		}),
		[],
	);
	assert.deepEqual(q.classify(1, "mandate_wrong"), []);
	assert.equal(q.ask().length, 1);
	assert.deepEqual(
		q.answer("build").map((m) => [m.event.kind, m.event.nodes]),
		[
			["queue_hold", ["sums"]],
			["revise_mandate", ["sums"]],
		],
	);
});

test("a backlogged investigation opens on the current plan and Mandate, not those at filing", () => {
	let current = false;
	const q = queue({
		...activeWorld,
		view: (lane) => {
			if (!current) return activeWorld.view(lane);
			if (lane === "build")
				return {
					phase: "active",
					plan: [{ ...plan[0], goal: "Revised ledger plan" }],
				};
			return {
				mandate: {
					intent: "Round after posting.",
					nodes: [],
					checks: [],
					delegated: [],
					considerations: null,
				},
			};
		},
	});
	const ownerFiling = { source: "owner", requestedOwner: true, item: null };
	const forged = q.attempt({ ...filing, requestedOwner: true });
	assert.match(
		"reject" in forged ? forged.reject : "",
		/on behalf of the owner/,
	);
	for (let i = 0; i < 2; i++) assert.deepEqual(q.file(ownerFiling), []);
	assert.deepEqual(q.ask(), []);
	assert.equal(q.agents().filter((a) => a.expect).length, 1);
	const original = q.agents()[0]!.expect!.input!();
	for (const part of [
		"commit-one",
		filing.text,
		filing.report,
		"sums",
		"Post each cent once.",
		plan[0]!.goal,
	])
		assert.ok(original.includes(part), part);
	q.file({ text: "Backlogged note" });
	current = true;
	q.classify();
	q.answer("drop");
	assert.match(q.view().findingsFor(filing.work), /\(dropped\)/);
	const input = q.agents()[0]!.expect!.input!();
	assert.match(input, /Backlogged note/);
	assert.match(input, /Revised ledger plan/);
	assert.match(input, /Round after posting/);
	assert.doesNotMatch(input, /Compare both ledger balances/);
});
test("a defect goes to the coordinator without triage; determined work waits for build", () => {
	for (const cls of ["defect_in_scope", "determined"]) {
		const q = queue();
		q.file({ blocking: cls === "defect_in_scope" });
		let out = q.classify(1, cls);
		if (cls === "determined") {
			assert.deepEqual(out, []);
			out = q.answer("build");
		}
		assert.equal(q.ask().length, 0);
		assert.deepEqual(
			out.map((m) => [m.lane, m.work, m.event.kind]),
			[["build", 4, "plan_finding"]],
		);
		assert.match(String(out[0]?.event.text), /calculations disagree/);
		assert.deepEqual(out[0]?.event.nodes, ["sums"]);
		assert.equal(
			out[0]?.event.cause,
			cls === "defect_in_scope" ? "queue/1" : undefined,
		);
		assert.equal(
			out[0]?.event.reference,
			cls === "determined" ? "signed spec" : "Current Mandate",
		);
	}
});
for (const choice of ["build", "defer"]) {
	test(`linked Mandate triage shows both reports and nodes; ${choice} handles both causes`, () => {
		const q = queue();
		q.file({ blocking: true });
		q.classify(1, "mandate_wrong");
		const previous = q.ask()[0]!.basis;
		q.file({
			text: "Are reversed postings lost?",
			report: "The smallest amount disagrees.",
			item: "second",
			blocking: true,
		});
		q.classify(2, "mandate_wrong", {
			sameAs: 1,
			nodes: ["totals"],
			cause: "reversed totals",
		});
		const [ask] = q.ask();
		assert.equal(q.ask().length, 1);
		assert.notEqual(ask!.basis, previous);
		assert.match(ask!.title, /wrong Mandate/i);
		assert.deepEqual(ask!.choices, ["build", "defer", "drop"]);
		assert.match(ask!.basis, /defer and drop.*blocked item.*same obstacle/i);
		assert.match(
			ask!.basis.split("\n", 1)[0]!,
			/rounding point.*reversed totals/,
		);
		assert.match(
			ask!.basis,
			/Which rounding boundary\?[\s\S]*Are reversed postings lost\?[\s\S]*## Mandate nodes[\s\S]*Round once\.[\s\S]*Totals include reversed postings/,
		);
		for (const evidence of [
			filing.report,
			"The smallest amount disagrees.",
			"The filer could not continue item second.",
			"Source: worker / Post each cent once. / second",
		])
			assert.ok(ask!.basis.includes(evidence), evidence);
		assert.doesNotMatch(
			ask!.basis,
			/Held items:|Waiting on held dependencies:|Keeps running:|queue conversation/,
		);
		const out = q.answer(choice);
		if (choice === "defer") {
			assert.deepEqual(
				out.map((m) => [m.event.kind, m.event.cause]),
				[
					["queue_release", "queue/1"],
					["queue_release", "queue/2"],
				],
			);
		} else {
			assert.ok(
				out.every((m) =>
					["queue_hold", "revise_mandate"].includes(m.event.kind),
				),
			);
			const revision = out.find((m) => m.event.kind === "revise_mandate");
			assert.deepEqual(
				[
					revision?.lane,
					revision?.work,
					revision?.event.causes,
					revision?.event.nodes,
				],
				["design", 4, ["queue/1", "queue/2"], ["sums", "totals"]],
			);
			assert.match(
				String(revision?.event.text),
				/smallest amount[\s\S]+Use the ledger boundary/,
			);
		}
	});
}

test("a second blocked filer linked to a defect being fixed stays held until that defect merges", () => {
	const q = queue();
	q.file({ blocking: true });
	q.classify(1, "defect_in_scope");
	q.file({
		item: "second",
		text: "Same defect blocks the other filer",
		blocking: true,
	});
	const messages = q.classify(2, "defect_in_scope", { sameAs: 1 });
	assert.deepEqual(
		messages.map((m) => [m.event.kind, m.event.cause]),
		[
			["queue_hold", "queue/1"],
			["queue_release", "queue/2"],
		],
	);
	assert.deepEqual(q.ask(), []);
	q.send({
		kind: "revision_disposition",
		work: 4,
		causes: ["queue/1"],
		disposition: "fixed by writer, stats",
	});
	assert.match(
		q.view().findingsFor(4),
		/Finding #2: Same defect blocks the other filer \(fixed by writer, stats\)/,
	);
	q.file({
		item: "second",
		text: "Still broken after the fix",
		blocking: true,
	});
	assert.deepEqual(q.classify(3, "defect_in_scope", { sameAs: 2 }), []);
	assert.match(q.ask()[0]!.basis, /#2[^\n]+fixed by writer, stats/);
});

test("owner and sweep counterexamples can replace a blessing; worker citations follow the current ruling", () => {
	const q = queue();
	const pattern = "round-last";
	q.file({ pattern });
	q.classify(1, "unapproved_pattern", { recommendation: "bless" });
	assert.deepEqual(q.ask()[0]!.choices, ["bless", "revoke", "defer"]);
	q.answer("bless");
	assert.deepEqual(
		q.file({ work: 5, text: "Use blessed pattern", pattern }),
		[],
	);
	assert.equal(q.agents().filter((a) => a.expect).length, 0);
	for (const [source, text] of [
		["owner", "Rounding last leaks a cent"],
		["sweeper", "Proof agrees"],
	]) {
		assert.deepEqual(
			q.file({ source, work: null, item: null, pattern, text }),
			[],
		);
	}
	q.classify(2, "unapproved_pattern", { recommendation: "revoke" });
	q.classify(3, "unapproved_pattern", { recommendation: "revoke", sameAs: 2 });
	assert.match(
		q.ask()[0]!.basis,
		/Rounding last leaks a cent[\s\S]*Proof agrees/,
	);
	assert.equal(q.view().patternRulings[0]?.status, "blessed");
	const [correction] = q.answer("revoke");
	assert.equal(correction?.work, "new");
	assert.match(
		String(correction?.event.text),
		/make the pattern round-last fail structurally/i,
	);
	assert.equal(q.view().patternRulings[0]?.status, "revoked");
	const [rework] = q.file({ work: 5, text: "Use revoked pattern", pattern });
	assert.deepEqual([rework?.event.kind, rework?.work], ["plan_finding", 5]);
	assert.match(String(rework?.event.text), /revoked.*round-last/i);

	q.file({
		work: null,
		source: "owner",
		text: "New evidence supports the pattern",
		pattern,
	});
	q.classify(5, "unapproved_pattern", { recommendation: "bless" });
	q.answer("bless");
	assert.deepEqual(
		q.file({ work: 5, text: "Use the newly blessed pattern", pattern }),
		[],
	);
	assert.equal(q.agents().filter((a) => a.expect).length, 0);
	assert.deepEqual(
		q.view().patternRulings.map(({ name, status }) => [name, status]),
		[[pattern, "blessed"]],
	);
});

test("explorers distinguish a revoked pattern from approved authority, and only the investigator shares its live context", async () => {
	const q = queue();
	for (const [i, [pattern, choice]] of (
		[
			["keep-cent", "bless"],
			["lose-cent", "revoke"],
		] as const
	).entries()) {
		q.file({ pattern });
		q.classify(i + 1, "unapproved_pattern", { recommendation: choice });
		q.answer(choice);
	}
	q.file({ text: "A new investigation" });
	for (const role of ["designer", "worker", "investigator"] as const) {
		const explorer = await explorerDispatch.resolve(
			{
				role,
				cwd: "/checkout",
				options: activeWorld.options,
				priorWorks: [],
				view: (name) => (name === "queue" ? q.view() : null),
			},
			{
				seat:
					role === "designer"
						? "design_explorer"
						: role === "investigator"
							? "queue_explorer"
							: "build_explorer",
				question: "Which rounding pattern is authoritative?",
			},
		);
		assert.ok(explorer);
		const text = explorer.instructions ?? "";
		assert.match(text, /"name": "keep-cent"[^}]*"status": "blessed"/);
		assert.match(text, /"name": "lose-cent"[^}]*"status": "revoked"/);
		if (role === "investigator")
			assert.match(text, /Compare both ledger balances/);
		else assert.doesNotMatch(text, /Compare both ledger balances/);
	}
});

test("A-4: a pattern ruling leaves the other decision and the uninvestigated filing open with their own evidence", () => {
	const q = queue();
	for (const text of [
		"Harmless helper",
		"The helper loses data",
		"The helper races with statistics",
	])
		q.file({ text, pattern: "legacy-writer" });
	q.classify(1, "unapproved_pattern", {
		recommendation: "bless",
		evidence: "No lost data in the simple probe.",
	});
	q.classify(2, "unapproved_pattern", {
		recommendation: "revoke",
		evidence: "The flush drops a record.",
	});
	const [first, second] = q.ask();
	assert.ok(first && second);
	assert.doesNotMatch(
		first.basis,
		/flush drops a record|races with statistics/,
	);
	assert.deepEqual(q.answer("bless", first.subject), []);
	assert.deepEqual(q.ask(), [second]);
	assert.match(second.basis, /flush drops a record/);
	assert.match(
		q.agents()[0]?.expect?.input?.() ?? "",
		/helper races with statistics/,
	);
	assert.equal(q.answer("revoke", second.subject)[0]?.work, "new");
	assert.deepEqual(
		q.view().patternRulings.map((p) => [p.name, p.status]),
		[["legacy-writer", "revoked"]],
	);
});

test("the last pattern answer wins even when it answers the first filing; a deferral does not replace it", () => {
	const q = queue();
	const pattern = "legacy-writer";
	q.file({ pattern, text: "An earlier positive report" });
	q.file({ pattern, text: "A later negative report" });
	q.classify(1, "unapproved_pattern", { recommendation: "bless" });
	q.classify(2, "unapproved_pattern", { recommendation: "revoke" });
	const [first, second] = q.ask();
	q.answer("revoke", second!.subject);
	q.answer("bless", first!.subject);
	q.file({ pattern, source: "owner", text: "An unresolved counterexample" });
	q.classify(3, "unapproved_pattern", { recommendation: "defer" });
	q.answer("defer");
	assert.deepEqual(
		q.file({ work: 5, pattern, text: "Use current precedent" }),
		[],
	);
	assert.deepEqual(
		q.view().patternRulings.map(({ name, status }) => [name, status]),
		[[pattern, "blessed"]],
	);
	assert.deepEqual(q.ask(), []);
});

test("determined work whose original build closed seeds new follow work with its reference", () => {
	let phase = "active";
	const q = queue({
		...activeWorld,
		view: (lane) =>
			lane === "build" ? { phase, plan } : activeWorld.view(lane),
	});
	q.file();
	q.classify();
	phase = "closed";
	const [seed] = q.answer("build");
	assert.equal(seed?.lane, "design");
	assert.equal(seed?.work, "new");
	assert.equal(seed?.event.kind, "queue_seed");
	assert.equal(seed?.event.route, "follow");
	assert.equal(seed?.event.reference, "signed spec");
	assert.match(String(seed?.event.text), /Use the ledger boundary/);
});

test("an investigation must answer the head finding and name its evidence, authority and affected nodes", () => {
	const q = queue();
	q.file();
	q.file({ text: "Second" });
	for (const report of [
		q.investigation(2),
		q.investigation(1, "determined", { reference: " " }),
		q.investigation(1, "mandate_wrong", { nodes: [] }),
		q.investigation(1, "mandate_wrong", { nodes: ["not-in-mandate"] }),
		q.investigation(1, "determined", { sameAs: 1 }),
		q.investigation(1, "determined", { evidence: " " }),
	])
		assert.ok("reject" in q.attempt(report), JSON.stringify(report));
	assert.deepEqual(q.ask(), []);
	assert.match(
		q.agents()[0]?.expect?.input?.() ?? "",
		/Which rounding boundary/,
	);
});

test("cancelling a work closes its open and pending Mandate revisions, but not other triage", () => {
	const q = queue();
	q.file({ text: "Needs an active revision" });
	q.classify(1, "mandate_wrong");
	q.answer("build");
	q.file();
	q.classify(2, "mandate_wrong");
	const cancelled = q.ask()[0]!.subject;
	q.file({ text: "Independent follow-up" });
	q.classify(3, "determined");
	q.file({ work: 5, text: "Another work's Mandate" });
	q.classify(4, "mandate_wrong");
	q.send({ kind: "cancel_work", work: 4 });
	assert.deepEqual(q.answer("build", cancelled), []);
	const remaining = q.ask().map((ask) => ask.basis);
	assert.equal(remaining.length, 2);
	assert.match(remaining[0]!, /Independent follow-up/);
	assert.match(remaining[1]!, /Another work's Mandate/);
	assert.match(
		q.view().findingsFor(4),
		/Needs an active revision \(cancelled\)/,
	);
	assert.match(
		q.view().findingsFor(4),
		/Which rounding boundary\? \(cancelled\)/,
	);
});

for (const choice of ["resume", "cancel"])
	test(`investigator stop asks the owner to ${choice}; cancel drops only that finding`, () => {
		const q = queue();
		q.file();
		const a = q.agents()[0]!;
		const tok = a.expect!.token;
		q.send({
			kind: "agent_stalled",
			cause: "stopped",
			agent: a.key,
			token: tok,
			lastWords: "waiting for evidence",
		});
		assert.equal(q.agents().filter((a) => a.expect).length, 0);
		assert.match(q.ask()[0]!.basis, /waiting for evidence/);
		const basis = q.ask()[0]!.basis;
		assert.deepEqual(q.ask()[0]!.choices, ["resume", "cancel"]);
		assert.match(basis, /Cancel drops the finding/);
		q.file({ text: "Independently check the decimal parser" });
		q.answer(choice);
		const exp = q.agents()[0]?.expect;
		const input = exp?.input?.() ?? "";
		if (choice === "resume") {
			assert.match(input, /## Finding #1[\s\S]*Which rounding boundary\?/);
			assert.match(input, /Use the ledger boundary\./);
		} else {
			assert.match(input, /Independently check the decimal parser/);
			assert.match(
				q.view().findingsFor(4),
				/Which rounding boundary\? \(dropped\)/,
			);
		}
		assert.match(input, /Compare both ledger balances/);
		assert.notEqual(exp?.token, tok);
	});
