import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import type { LaneEvent, Message, World } from "../src/kernel/lane.ts";
import { queueLane } from "../src/lanes/queue/index.ts";
import { explorerDispatch } from "../src/roles/dispatch.ts";
import { drive } from "./fixtures/drive.ts";

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
		let s = l.state.initial();
		const attempt = (e: LaneEvent) => drive(l, s, e, world);
		let notes: string[] = [];
		const send = (e: LaneEvent): Message[] => {
			const r = attempt(e);
			if ("reject" in r) assert.fail(r.reject);
			s = r.state;
			const outgoing = (r.send ?? []).filter((m) => {
				if (
					m.lane !== "queue" ||
					!["begin_investigation", "intake"].includes(m.event.kind)
				)
					return true;
				send(m.event);
				return false;
			});
			notes = r.notes?.map((n) => n.text) ?? [];
			return outgoing;
		};
		const file = (over: Partial<LaneEvent> = {}) =>
			send({ ...filing, ...over } as LaneEvent);
		const investigation = (
			finding = 1,
			classification = "determined",
			extra: LaneEvent[string] = {},
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
			...(extra as object),
		});
		const effects = () => l.effects(s, world);
		const ask = () => l.asks(s, world);
		const answer = (choice: string, subject = ask()[0]!.subject) =>
			send({
				kind: "answered",
				subject,
				choice,
				decision: "d1",
				annotations: [{ n: 1, text: "Use the ledger boundary." }],
			});
		const agents = () => l.agents(s, world);
		return {
			send,
			file,
			attempt,
			investigation,
			ask,
			answer,
			agents,
			effects,
			state: () => s,
			notes: () => notes,
			view: () =>
				l.view(s) as {
					findingsFor(work: number): string;
					owedChecks(except?: number[]): string;
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

const missing = {
	source: "owner",
	missingCheck: true,
	text: "Reject a zero-sized lot.",
	item: null,
	blocking: false,
};
const finished = (outcome: string, encoded: number[] = []) => ({
	kind: "checks_finished",
	ids: [1],
	encoded,
	outcome,
});

test("a rejection names the check and annotation, and build lists it until encoding lands", () => {
	const q = queue();
	q.file(missing);
	const ask = q.ask()[0]!;
	assert.match(ask.title, /Reject a zero-sized lot/);
	assert.match(ask.basis, /Your annotation: Reject a zero-sized lot/);
	assert.match(ask.basis, /commit-one[\s\S]*calculations disagree/);
	assert.doesNotMatch(ask.basis, /Reference:/);
	assert.deepEqual(ask.choices, ["build", "defer", "drop"]);
	assert.match(
		ask.basis,
		/Build starts work to encode this check\. Defer keeps it owed and listed\. Drop clears it\./,
	);
	assert.equal(q.agents().flatMap((a) => a.expects).length, 0);
	assert.match(q.view().owedChecks(), /in triage/);
	const [seed] = q.answer("build");
	assert.equal(seed?.work, "new");
	assert.deepEqual(seed?.event.owed, [1]);
	assert.match(q.view().owedChecks(), /being built/);
	q.send(finished("Landed at new-trunk.", [1]));
	assert.equal(q.view().owedChecks(), "");
	assert.deepEqual(q.ask(), []);
});

test("repeating an outstanding rejection does not create a duplicate; a deferred check stays listed and can still be dropped", () => {
	const q = queue();
	q.file(missing);
	q.file({
		...missing,
		work: 5,
		sha: "commit-two",
		text: "  Reject a zero-sized lot.  ",
	});
	assert.equal(q.ask().length, 1);
	assert.deepEqual(q.answer("defer"), []);
	assert.match(q.view().owedChecks(), /Reject a zero-sized lot.*deferred/);
	assert.equal(
		q
			.view()
			.owedChecks()
			.match(/Reject a zero-sized lot/g)?.length,
		1,
	);
	assert.deepEqual(q.ask()[0]?.choices, ["build", "defer", "drop"]);
	assert.equal(q.ask().length, 1);
	q.answer("drop");
	assert.equal(q.view().owedChecks(), "");
	assert.deepEqual(q.ask(), []);
});

test("a later objection filed by the owner's desk is investigated, not owed", () => {
	const q = queue({
		...activeWorld,
		view: (lane) =>
			lane === "verify"
				? {
						landed: "landed-result",
						passedResult: () => ({
							sha: "landed-result",
							evidence: "Previous proof.",
						}),
					}
				: null,
	});
	q.file({
		source: "owner",
		requestedOwner: true,
		overridePassed: true,
		item: null,
	});
	assert.deepEqual(q.ask(), []);
	assert.equal(q.agents().flatMap((a) => a.expects).length, 1);
	q.send(q.investigation());
	q.answer("drop");
	assert.equal(q.view().owedChecks(), "");
});

test("drop clears the obligation; a later rejection opens a new check with only its own evidence", () => {
	const q = queue();
	q.file(missing);
	q.answer("drop");
	assert.equal(q.view().owedChecks(), "");
	q.file({
		...missing,
		work: 5,
		sha: "commit-two",
		report: "The later verifier missed it again.",
	});
	assert.equal(q.ask().length, 1);
	assert.equal(q.ask()[0]?.subject, "triage/2");
	assert.match(q.ask()[0]!.basis, /commit-two[\s\S]*missed it again/);
	assert.doesNotMatch(q.ask()[0]!.basis, /commit-one/);
});

for (const outcome of [
	"Encoding work was cancelled.",
	"Encoding work was declined.",
	"Trunk was unchanged.",
])
	test(`an assigned check returns to triage when work ends without encoding: ${outcome}`, () => {
		const q = queue();
		q.file(missing);
		const [ask] = q.ask();
		q.answer("build");
		assert.deepEqual(q.ask(), []);
		q.send(finished(outcome));
		const [reopened] = q.ask();
		assert.equal(reopened?.subject, ask?.subject);
		assert.ok(reopened?.basis.includes(outcome));
		assert.match(q.view().owedChecks(), /in triage/);
		q.answer("drop");
		assert.equal(q.view().owedChecks(), "");
	});

test("an investigator cannot close a project finding as no action", () => {
	const q = queue();
	q.file({ source: "sweeper", work: null, item: null });
	const result = q.attempt(
		q.investigation(1, "no_action", { nodes: [], recommendation: "no_action" }),
	);
	assert.match("reject" in result ? result.reject : "", /work/);
	const [turn] = q.agents()[0]!.expects;
	assert.match(turn!.input!(), /project finding[\s\S]*no_action/);
	q.send(q.investigation(1, "sets_precedent", { nodes: [] }));
	assert.equal(q.ask().length, 1);
});

test("the project sweep is off by default; when enabled its interruptible effect sleeps and failure re-arms it", () => {
	const off = queue();
	off.send({ kind: "sweep_configured" });
	assert.deepEqual(off.effects(), []);
	const q = queue({
		...activeWorld,
		options: { ...activeWorld.options, sweep_minutes: 1 },
	});
	q.send({ kind: "sweep_configured" });
	const [tick] = q.effects();
	assert.equal(tick?.interruptible, true);
	assert.equal(tick?.delayMs, 60_000);
	assert.deepEqual(
		q.send({
			kind: "effect_failed",
			key: tick!.key,
			error: "Failed to inspect the checkout",
		}),
		[],
	);
	assert.notEqual(q.effects()[0]?.key, tick!.key);
	assert.deepEqual(q.ask(), []);
});

test("sweep history carries dropped and deferred drift evidence, not ordinary findings or the synthetic revisit", () => {
	const facts = {
		...activeWorld,
		options: { ...activeWorld.options, sweep_minutes: 1 },
	};
	const q = queue(facts);
	q.send({ kind: "sweep_configured" });
	const tick = () =>
		q.send({
			kind: "effect_done",
			key: q.effects()[0]!.key,
			result: { findings: [] },
		});
	q.file({ source: "owner", text: "Ordinary owner finding" });
	q.send(q.investigation(1));
	q.answer("defer");
	for (const [i, disposition] of ["drop", "defer"].entries()) {
		q.file({
			source: "sweeper",
			work: null,
			text: `Drift ${i}`,
			report: `Evidence ${i}`,
		});
		q.send(q.investigation(i + 2, "sets_precedent", { nodes: [] }));
		q.answer(disposition);
	}
	facts.now += 31 * 86_400_000;
	tick();
	assert.match(q.ask()[0]!.title, /long-deferred findings/);
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
		assert.deepEqual(
			q.send(q.investigation(1, classification, { nodes: [] })),
			[],
		);
		assert.match(q.ask()[0]!.basis, /The playbook calls a removed command/);
		const [seed] = q.answer("build");
		assert.equal(seed?.work, "new");
		assert.equal(seed?.event.kind, "queue_seed");
	}
});

test("owner and sweep findings reopen a blessed pattern without withdrawing authority before revoke", () => {
	for (const source of ["owner", "sweeper"]) {
		const q = queue();
		q.file({ pattern: "round-last" });
		q.send(
			q.investigation(1, "unapproved_pattern", { recommendation: "bless" }),
		);
		q.answer("bless");
		assert.deepEqual(
			q.file({
				source,
				work: null,
				item: null,
				pattern: "round-last",
				text: "Rounding last leaks a cent.",
			}),
			[],
		);
		q.send(
			q.investigation(2, "unapproved_pattern", { recommendation: "revoke" }),
		);
		assert.match(q.ask()[0]!.basis, /Rounding last leaks a cent/);
		assert.equal(q.view().patternRulings[0]?.status, "blessed");
		assert.equal(q.answer("revoke")[0]?.work, "new");
		assert.equal(q.view().patternRulings[0]?.status, "revoked");
	}
});

test("a sweep keeps prior deferrals in its history without asking about them again after 30 days", () => {
	const facts = {
		...activeWorld,
		options: { ...activeWorld.options, sweep_minutes: 1 },
	};
	const q = queue(facts);
	q.send({ kind: "sweep_configured" });
	q.file({ text: "An old drift finding", work: null, source: "sweeper" });
	q.send(q.investigation(1));
	q.answer("defer");
	facts.now += 31 * 86_400_000;
	q.send({
		kind: "effect_done",
		key: q.effects()[0]!.key,
		result: { findings: [] },
	});
	assert.deepEqual(q.ask(), []);
	assert.match(
		JSON.stringify(q.view().priorFindings),
		/An old drift finding.*deferred/,
	);
});

test("a sweep proposal names its measured principle evidence and schedules no work until triage build", () => {
	const q = queue({
		...activeWorld,
		options: { ...activeWorld.options, sweep_minutes: 1 },
	});
	q.send({ kind: "sweep_configured" });
	const [scan] = q.effects();
	const result = {
		findings: [
			{
				text: "Bind project/round-once to ledger work",
				report: "Pulled on 9 of 10 landed items",
				pattern: null,
				principle: true,
			},
		],
	};
	q.send({ kind: "effect_done", key: scan!.key, result });
	assert.ok(
		"reject" in
			q.attempt(
				q.investigation(1, "no_action", {
					nodes: [],
					recommendation: "no_action",
				}),
			),
	);
	assert.deepEqual(
		q.send(q.investigation(1, "sets_precedent", { nodes: [] })),
		[],
	);
	assert.match(q.ask()[0]!.basis, /Bind project\/round-once[\s\S]*9 of 10/);
	assert.deepEqual(q.answer("drop"), []);
});

test("filing twice opens one investigation with the source revision, report, nodes and current plan; owner input schedules no work", () => {
	const q = queue();
	for (let i = 0; i < 2; i++)
		assert.deepEqual(q.file({ source: "owner", item: null }), []);
	assert.deepEqual(q.ask(), []);
	const agents = q.agents();
	assert.equal(agents.length, 1);
	assert.equal(agents[0]?.role, "investigator");
	const [turn] = agents[0]!.expects;
	for (const part of [
		"commit-one",
		filing.text,
		filing.report,
		"sums",
		"Post each cent once.",
		plan[0]!.goal,
	])
		assert.ok(turn?.input?.().includes(part), part);
	q.file({ text: "second report" });
	assert.equal(q.agents().length, 1);
	assert.equal(q.agents()[0]?.expects.length, 1);
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
test("a blocking filer holds only itself; classification holds named nodes immediately and drop releases the cause", () => {
	const q = queue();
	const [own] = q.file({ blocking: true });
	assert.deepEqual(
		[own?.lane, own?.work, own?.event.kind, own?.event.item, own?.event.nodes],
		["build", 4, "queue_hold", "ledger", []],
	);
	const [nodes] = q.send(q.investigation(1, "mandate_wrong"));
	assert.deepEqual(
		[nodes?.event.kind, nodes?.event.nodes, nodes?.event.cause],
		["queue_hold", ["sums"], own?.event.cause],
	);
	const subject = q.ask()[0]!.subject;
	const [release] = q.answer("drop");
	assert.deepEqual(
		[release?.lane, release?.event.kind, release?.event.cause],
		["build", "queue_release", own?.event.cause],
	);
	assert.deepEqual(q.answer("build", subject), []);
	assert.match(JSON.stringify(q.state()), /dropped/);
});
test("five findings about two causes leave two open decisions, each showing every member", () => {
	const q = queue();
	for (const text of [
		"First discrepancy",
		"Unclear flag",
		"Another discrepancy",
		"Another flag",
		"Third discrepancy",
	])
		q.file({ text });
	q.send(q.investigation(1, "sets_precedent"));
	q.send(q.investigation(2, "sets_precedent", { cause: "flag semantics" }));
	const original = q.ask();
	const next = q.agents()[0]!.expects[0]!.input!();
	assert.match(next, /#1.*triage.*sets_precedent.*rounding point/);
	assert.match(next, /#2.*triage.*sets_precedent.*flag semantics/);
	q.send(q.investigation(3, "sets_precedent", { sameAs: 1, cause: "" }));
	assert.deepEqual(q.notes(), []);
	q.send(
		q.investigation(4, "sets_precedent", {
			sameAs: 2,
			cause: "a paraphrase is not needed",
		}),
	);
	q.send(q.investigation(5, "sets_precedent", { sameAs: 3 }));
	const current = q.ask();
	assert.equal(current.length, 2);
	assert.notEqual(current[0]!.basis, original[0]!.basis);
	assert.notEqual(current[1]!.basis, original[1]!.basis);
	assert.match(
		current[0]!.basis,
		/First discrepancy[\s\S]+Another discrepancy[\s\S]+Third discrepancy/,
	);
	assert.match(current[1]!.basis, /Unclear flag[\s\S]+Another flag/);
	const seeds = q
		.answer("build", original[0]!.subject)
		.filter((m) => m.work === "new");
	assert.equal(seeds.length, 1);
	const seed = String(seeds[0]?.event.text);
	for (const member of [
		"First discrepancy",
		"Another discrepancy",
		"Third discrepancy",
		"Use the ledger boundary",
	])
		assert.ok(seed.includes(member));
	assert.doesNotMatch(seed, /Unclear flag/);
	q.answer("drop", original[1]!.subject);
	assert.deepEqual(q.ask(), []);
});

test("linking by number does not let a finding join a different classification or authority", () => {
	const q = queue();
	q.file();
	q.file({ text: "Other discrepancy" });
	q.send(q.investigation());
	for (const [cls, extra] of [
		["determined", { reference: "another spec" }],
		["sets_precedent", {}],
	] as const)
		assert.ok(
			"reject" in q.attempt(q.investigation(2, cls, { sameAs: 1, ...extra })),
		);
	q.send(q.investigation(2, "sets_precedent"));
	assert.equal(q.ask().length, 2);
});

test("a link after drop or build under an approved reference needs its own answer and retains the filer hold", () => {
	for (const choice of ["drop", "build"]) {
		const q = queue();
		q.file();
		q.send(q.investigation());
		const previous = q.ask()[0]!.subject;
		q.answer(choice);
		q.file({ text: "Same cause after the answer", blocking: true });
		assert.deepEqual(
			q.send(q.investigation(2, "determined", { sameAs: 1, cause: "" })),
			[],
		);
		const next = q.ask()[0]!;
		assert.notEqual(next.subject, previous);
		assert.match(next.basis, /Finding #2: Same cause after the answer/);
		assert.match(next.basis, /#1[^\n]+Which rounding boundary/);
		assert.match(
			next.basis,
			new RegExp(choice === "drop" ? "dropped" : "build"),
		);
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
		q.send(q.investigation(1, "mandate_wrong"));
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
		const messages = q.send(q.investigation(2, "mandate_wrong", { sameAs: 1 }));
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

test("a link to a deferred finding opens a new decision citing the earlier report and defer", () => {
	const q = queue();
	q.file();
	q.send(q.investigation());
	const first = q.ask()[0]!.subject;
	q.answer("defer");
	q.file({ text: "Filed again with new evidence" });
	q.send(q.investigation(2, "determined", { sameAs: 1 }));
	const next = q.ask()[0]!;
	assert.notEqual(next.subject, first);
	assert.match(next.basis, /Which rounding boundary/);
	assert.match(next.basis, /Filed again with new evidence/);
	assert.match(next.basis, /deferred/);
	assert.deepEqual(q.answer("build", first), []);
	assert.equal(q.answer("build", next.subject)[0]?.event.kind, "plan_finding");
});

test("an identical re-filing after defer is investigated once and can reopen the original", () => {
	const q = queue();
	q.file();
	q.send(q.investigation());
	const first = q.ask()[0]!.subject;
	q.answer("defer");
	q.file();
	q.file();
	assert.match(
		q.agents()[0]?.expects[0]?.input?.() ?? "",
		/Investigate finding #2/,
	);
	q.send(q.investigation(2, "determined", { sameAs: 1, cause: "" }));
	assert.notEqual(q.ask()[0]?.subject, first);
	assert.equal(q.agents()[0]?.expects.length, 0);
});

test("the investigator can close a non-blocking observation with a reason but not a blocked filer or the owner's finding", () => {
	const q = queue();
	q.file({ source: "verifier", text: "Other readers unchanged" });
	q.file({
		source: "owner",
		text: "MISSING-CHECK: the owner rejected hand-over",
	});
	q.file({ text: "I am blocked", blocking: true });
	const closure = {
		recommendation: "no_action",
		evidence: "The observations match the bound rule.",
		nodes: [],
	};
	assert.deepEqual(q.send(q.investigation(1, "no_action", closure)), []);
	assert.deepEqual(q.ask(), []);
	assert.match(
		q.view().findingsFor(4),
		/no action: The observations match the bound rule/,
	);
	assert.ok("reject" in q.attempt(q.investigation(2, "no_action", closure)));
	q.send(q.investigation(2, "sets_precedent"));
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
	const [note] = q.send(
		q.investigation(1, "no_action", {
			recommendation: "no_action",
			nodes: [],
			evidence: "The format already requires an empty line.",
		}),
	);
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
	assert.deepEqual(q.send(q.investigation(1, "mandate_wrong")), []);
	assert.match(q.ask()[0]!.basis, /Round once/);
	assert.match(q.ask()[0]!.basis, /does not hold.*landing/i);
	assert.equal(q.answer("build")[0]?.work, "new");
});

test("hand-over evidence for the work includes dispositions and open findings but not other work", () => {
	const q = queue();
	q.file({ text: "Closed as an observation" });
	q.send(
		q.investigation(1, "no_action", {
			recommendation: "no_action",
			nodes: [],
			evidence: "Nothing needs editing.",
		}),
	);
	q.file({ text: "Deferred concern" });
	q.send(q.investigation(2));
	q.answer("defer");
	q.file({ text: "Settled rounding boundary" });
	q.send(q.investigation(3, "mandate_wrong"));
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
	assert.deepEqual(q.send(q.investigation(1, "mandate_wrong")), []);
	assert.equal(q.ask().length, 1);
	assert.deepEqual(
		q.answer("build").map((m) => [m.event.kind, m.event.nodes]),
		[
			["queue_hold", ["sums"]],
			["revise_mandate", ["sums"]],
		],
	);
});

test("a blocked filer classified as a defect keeps its cause on the fix request and is not released", () => {
	const q = queue();
	q.file({ blocking: true });
	assert.deepEqual(
		q
			.send(q.investigation(1, "defect_in_scope"))
			.map((m) => [m.event.kind, m.event.cause]),
		[["plan_finding", "queue/1"]],
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
	q.file();
	q.file({ text: "Backlogged note" });
	current = true;
	q.send(q.investigation());
	const input = q.agents()[0]!.expects[0]!.input!();
	assert.match(input, /Revised ledger plan/);
	assert.match(input, /Round after posting/);
	assert.doesNotMatch(input, /Compare both ledger balances/);
});
test("a defect goes to the coordinator without triage; determined work waits for build", () => {
	for (const cls of ["defect_in_scope", "determined"]) {
		const q = queue();
		q.file();
		let out = q.send(q.investigation(1, cls));
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
			out[0]?.event.reference,
			cls === "determined" ? "signed spec" : "Current Mandate",
		);
	}
});
test("a linked blocker is shown in reissued triage with both reports and both nodes", () => {
	const q = queue();
	q.file();
	q.file({
		text: "Same issue in another item",
		item: "second",
		blocking: true,
	});
	q.send(q.investigation(1, "mandate_wrong"));
	const previous = q.ask()[0]!.basis;
	q.send(
		q.investigation(2, "mandate_wrong", {
			sameAs: 1,
			nodes: ["totals"],
			cause: "reversed totals",
		}),
	);
	assert.equal(q.ask().length, 1);
	const basis = q.ask()[0]!.basis;
	assert.notEqual(basis, previous);
	assert.match(basis.split("\n", 1)[0]!, /rounding point.*reversed totals/);
	assert.match(basis, /## Mandate nodes\n\n### sums/);
	for (const text of [
		"Finding #1",
		filing.report,
		"Finding #2",
		"Same issue in another item",
		"The filer could not continue item second.",
		"Round once.",
		"Totals include reversed postings.",
		"Source: worker / Post each cent once. / second",
	])
		assert.ok(basis.includes(text), text);
	assert.doesNotMatch(
		basis,
		/Held items:|Waiting on held dependencies:|Keeps running:|queue conversation/,
	);
	assert.deepEqual(q.notes(), []);
	assert.deepEqual(
		q.answer("defer").map((m) => [m.event.kind, m.event.cause]),
		[
			["queue_release", "queue/1"],
			["queue_release", "queue/2"],
		],
	);
	if (process.env.KEEL_REWORK_RENDERS)
		writeFileSync("/tmp/keel-queue-rework2-triage.md", basis);
});

test("a second blocked filer linked to a defect being fixed stays held until that defect merges", () => {
	const q = queue();
	q.file({ blocking: true });
	q.send(q.investigation(1, "defect_in_scope"));
	q.file({
		item: "second",
		text: "Same defect blocks the other filer",
		blocking: true,
	});
	const messages = q.send(q.investigation(2, "defect_in_scope", { sameAs: 1 }));
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
	assert.deepEqual(
		q.send(q.investigation(3, "defect_in_scope", { sameAs: 2 })),
		[],
	);
	assert.match(q.ask()[0]!.basis, /#2[^\n]+fixed by writer, stats/);
});

test("a blessed pattern is an approved reference across works; revoke seeds structural correction instead", () => {
	for (const choice of ["bless", "revoke"]) {
		const q = queue();
		q.file({ pattern: "round-last" });
		q.send(
			q.investigation(1, "unapproved_pattern", { recommendation: choice }),
		);
		assert.deepEqual(q.ask()[0]!.choices, ["bless", "revoke", "defer"]);
		const out = q.answer(choice);
		if (choice === "bless") {
			q.file({ work: 5, text: "later ruling", pattern: "round-last" });
			assert.equal(q.agents().flatMap((a) => a.expects).length, 0);
			assert.doesNotMatch(JSON.stringify(q.state()), /later ruling/);
		} else {
			assert.equal(out[0]?.work, "new");
			assert.match(String(out[0]?.event.text), /round-last/);
			const later = q.file({
				work: 5,
				text: "LATER: use revoked pattern",
				pattern: "round-last",
			});
			assert.deepEqual(
				later.map((m) => [m.event.kind, m.work]),
				[["plan_finding", 5]],
			);
			assert.match(String(later[0]?.event.text), /revoked.*round-last/i);
			assert.equal(q.ask().length, 0);
		}
	}
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
		q.send(
			q.investigation(i + 1, "unapproved_pattern", { recommendation: choice }),
		);
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
	q.send(
		q.investigation(1, "unapproved_pattern", {
			recommendation: "bless",
			evidence: "No lost data in the simple probe.",
		}),
	);
	q.send(
		q.investigation(2, "unapproved_pattern", {
			recommendation: "revoke",
			evidence: "The flush drops a record.",
		}),
	);
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
		q.agents()[0]?.expects[0]?.input?.() ?? "",
		/helper races with statistics/,
	);
	assert.equal(q.answer("revoke", second.subject)[0]?.work, "new");
	assert.deepEqual(
		q.view().patternRulings.map((p) => [p.name, p.status]),
		[["legacy-writer", "revoked"]],
	);
});

test("a later blessing replaces a prior revocation and governs the next citation", () => {
	const q = queue();
	const pattern = "legacy-writer";
	q.file({ pattern });
	q.send(
		q.investigation(1, "unapproved_pattern", { recommendation: "revoke" }),
	);
	q.answer("revoke");
	q.file({ work: null, text: "New evidence supports the pattern", pattern });
	q.send(q.investigation(2, "unapproved_pattern", { recommendation: "bless" }));
	q.answer("bless");
	assert.deepEqual(
		q.file({ text: "Use the newly blessed pattern", pattern }),
		[],
	);
	assert.equal(q.agents()[0]?.expects.length, 0);
	assert.deepEqual(
		q.view().patternRulings.map(({ name, status }) => [name, status]),
		[[pattern, "blessed"]],
	);
});

test("determined work whose original build closed seeds new follow work with its reference", () => {
	let phase = "active";
	const q = queue({
		...activeWorld,
		view: (lane) =>
			lane === "build" ? { phase, plan } : activeWorld.view(lane),
	});
	q.file();
	q.send(q.investigation());
	phase = "closed";
	const [seed] = q.answer("build");
	assert.equal(seed?.lane, "design");
	assert.equal(seed?.work, "new");
	assert.equal(seed?.event.kind, "queue_seed");
	assert.equal(seed?.event.route, "follow");
	assert.equal(seed?.event.reference, "signed spec");
	assert.match(String(seed?.event.text), /Use the ledger boundary/);
});

test("approving triage asks the designer of the same work for a revision and keeps both causes held", () => {
	const q = queue();
	const [own] = q.file({ blocking: true });
	q.send(q.investigation(1, "mandate_wrong"));
	q.file({
		text: "Try a half-cent",
		report: "The smallest amount that disagrees.",
	});
	const [second] = q.send(q.investigation(2, "mandate_wrong", { sameAs: 1 }));
	const out = q.answer("build");
	const revision = out.find((m) => m.event.kind === "revise_mandate");
	assert.ok(
		out.every((m) => ["queue_hold", "revise_mandate"].includes(m.event.kind)),
	);
	assert.equal(revision?.lane, "design");
	assert.equal(revision?.work, 4);
	assert.deepEqual(revision?.event.causes, [
		own?.event.cause,
		second?.event.cause,
	]);
	assert.deepEqual(revision?.event.nodes, ["sums"]);
	assert.match(
		String(revision?.event.text),
		/smallest amount[\s\S]+Use the ledger boundary/,
	);
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
		q.agents()[0]?.expects[0]?.input?.() ?? "",
		/Which rounding boundary/,
	);
});

test("cancelling a work closes only its wrong-Mandate decisions and makes old answers inert", () => {
	const q = queue();
	q.file();
	q.send(q.investigation(1, "mandate_wrong"));
	const cancelled = q.ask()[0]!.subject;
	q.file({ text: "Independent follow-up" });
	q.send(q.investigation(2, "determined"));
	q.file({ work: 5, text: "Another work's Mandate" });
	q.send(q.investigation(3, "mandate_wrong"));
	const out = q.send({ kind: "cancel_work", work: 4 });
	assert.equal(out.length, 3);
	assert.ok(out.every((m) => m.work === 4 && m.event.kind === "cancel"));
	assert.deepEqual(q.answer("build", cancelled), []);
	const remaining = q.ask().map((ask) => ask.basis);
	assert.equal(remaining.length, 2);
	assert.ok(remaining.some((basis) => basis.includes("Independent follow-up")));
	assert.ok(
		remaining.some((basis) => basis.includes("Another work's Mandate")),
	);
	assert.match(JSON.stringify(q.state()), /cancelled/);
});

test("cancelling work closes its pending revision findings rather than leaving them open", () => {
	const q = queue();
	q.file({ text: "Needs an active revision" });
	q.send(q.investigation(1, "mandate_wrong"));
	q.answer("build");
	q.send({ kind: "cancel_work", work: 4 });
	assert.match(
		q.view().findingsFor(4),
		/Needs an active revision \(cancelled\)/,
	);
});

test("wrong-Mandate triage identifies the decision, shows the reports before their node text, and explains releasing the blocked item", () => {
	const q = queue();
	q.file({ blocking: true });
	q.send(q.investigation(1, "mandate_wrong"));
	q.file({ text: "Are reversed postings lost?", nodes: ["totals"] });
	q.send(q.investigation(2, "mandate_wrong", { nodes: ["totals"], sameAs: 1 }));
	const [ask] = q.ask();
	assert.deepEqual(ask?.choices, ["build", "defer", "drop"]);
	assert.match(ask!.title, /wrong Mandate/i);
	assert.match(ask!.basis, /defer and drop.*blocked item.*same obstacle/i);
	assert.match(ask!.basis, /Which rounding boundary\?[\s\S]*Round once\./);
	assert.match(
		ask!.basis,
		/Are reversed postings lost\?[\s\S]*Totals include reversed postings\./,
	);
});

test("a deferred Mandate finding releases its causes just as a dropped one does", () => {
	const q = queue();
	q.file();
	const [hold] = q.send(q.investigation(1, "mandate_wrong"));
	const out = q.answer("defer");
	assert.deepEqual(
		out.map((m) => [m.lane, m.work, m.event.kind, m.event.cause]),
		[["build", 4, "queue_release", hold?.event.cause]],
	);
	assert.match(String(out[0]?.event.direction), /Use the ledger boundary/);
	assert.deepEqual(q.ask(), []);
	assert.match(JSON.stringify(q.state()), /deferred/);
});

test("investigator stop is left to the owner; resume declares a fresh input for the same finding", () => {
	const q = queue();
	q.file();
	const a = q.agents()[0]!;
	const tok = a.expects[0]!.token;
	q.send({
		kind: "agent_stalled",
		cause: "stopped",
		agent: a.key,
		tokens: [tok],
		lastWords: "waiting for evidence",
	});
	assert.equal(q.agents().flatMap((a) => a.expects).length, 0);
	assert.match(q.ask()[0]!.basis, /waiting for evidence/);
	const basis = q.ask()[0]!.basis;
	q.answer("resume");
	const exp = q.agents()[0]?.expects[0];
	const input = exp?.input?.() ?? "";
	assert.ok(input.includes(filing.text));
	assert.match(input, /Use the ledger boundary\./);
	assert.match(input, /Compare both ledger balances/);
	assert.match(basis, /Cancel drops the finding/);
	assert.notEqual(exp?.token, tok);
});
