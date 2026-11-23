import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import { explorerDispatch } from "../src/roles/dispatch.ts";
import {
	reviewDriver as run,
	designWorld as world,
} from "./fixtures/design-review.ts";
import { holdingChoice } from "./fixtures/drive.ts";

const reference = "Approved line format, ADR 4";
const seed = {
	kind: "queue_seed",
	route: "follow",
	text: "Restore the newline in exported reports. Evidence: fixture F3.",
	reference,
};
const rule = {
	label: "R1",
	rule: "Emit one raw line.",
	probe: "Compare bytes.",
};
const untouched = {
	label: "R2",
	rule: "Keep the report timestamp.",
	probe: "Check the report timestamp.",
};
const correction = {
	...rule,
	rule: "Emit one escaped line.",
	probe: "Check embedded input newlines.",
};
const small = {
	intent: "Restore report exports.",
	nodes: [rule, untouched],
	checks: [{ id: "P1", argv: ["verify-report"], timeoutMs: 1000 }],
};
const follow = { kind: "ground", route: "follow", reference, mandate: small };
const audit = {
	exists: "The reports use a shell writer.",
	gaps: [],
	contradictions: [],
};
const precedent = { kind: "ground", route: "precedent", reference, audit };
const seam = {
	label: "S1",
	callersNow: "Report job",
	callersLater: "Audit reader",
	usage: '```sh\nwrite_report "$file"\n```',
	signature: "```sh\nwrite_report file\n```",
	owner: "Reporting",
	dependencies: "Shell only",
};
const draft = {
	...small,
	done: "The report is readable.",
	never: "Two writers.",
	tradeoffs: "Fewer caller choices.",
	alternatives: "A second export path.",
	seams: [seam],
	settlements: [],
	references: [{ label: "P1", source: "Approved report probe ADR 9" }],
	riders: [
		{
			label: "A",
			text: "Keep the old file name.",
			origin: "evidence",
			disposition: "bind",
		},
	],
};
const request = {
	kind: "revise_mandate",
	causes: ["queue/1", "queue/2"],
	nodes: ["R1"],
	text: "F9 reproduces a report split on an embedded newline at abc123.",
};
const answerCauses = (
	causes: string[],
	nodes: string[],
	reason = "The revised contract covers this case.",
) => causes.map((cause) => ({ cause, nodes, reason }));
const publish = {
	kind: "publish_revision",
	changes: { nodes: [correction] },
	answers: answerCauses(request.causes, ["R1"]),
	replies: [],
};
const activated = { kind: "revision_activated", causes: request.causes };
const reply = { n: 1, status: "acted_on", reason: "Test a tab too." };
const note = { n: 1, text: "Keep escapes readable." };

test("successful Ground on any route and queue seeds arm an enabled sweep, not a disabled one", () => {
	for (const event of [
		follow,
		precedent,
		{ kind: "ground", route: "ambiguous", reference, readings: ["A", "B"] },
		seed,
	]) {
		for (const enabled of [false, true]) {
			const options = enabled
				? { ...world.options, sweep_minutes: 1 }
				: world.options;
			const { send } = run({ ...world, options }).send(event);
			assert.equal(
				(send ?? []).some(
					(m) =>
						m.lane === "queue" &&
						m.work === null &&
						m.event.kind === "sweep_configured",
				),
				enabled,
				JSON.stringify(event),
			);
		}
	}
});

async function explorerHistory(
	works: ReturnType<typeof run>[],
	current?: ReturnType<typeof run>,
) {
	const ruling = {
		item: "writer",
		what: "Validate before writing.",
		why: "Preserve bytes on failure.",
		cost: "Lost data.",
		rank: 1,
		follows: "R1",
		principles: [],
	};
	const view = (x?: ReturnType<typeof run>) => (name: string) =>
		name === "design" ? (x?.view() ?? null) : x ? { rulings: [ruling] } : null;
	const seat = await explorerDispatch.resolve(
		{
			role: "designer",
			cwd: world.root,
			options: world.options,
			view: view(current),
			priorWorks: works.map((x, i) => ({
				work: (i + 2) as WorkId,
				view: view(x),
			})),
		},
		{ seat: "design_explorer", question: "What did the owner approve?" },
	);
	assert.ok(seat?.instructions);
	return JSON.parse(
		seat.instructions.slice(seat.instructions.indexOf("\n{")),
	) as {
		design: unknown;
		rulings: unknown[];
		priorWorks: {
			work: number;
			mandate?: unknown;
			revisionNodes?: unknown;
			rulings: unknown[];
		}[];
		earlierWorks: {
			work: number;
			goal: string;
			nodes: { label: string; line: string }[];
		}[];
	};
}

function historicalReview(choice: "approve" | "decline", goal = small.intent) {
	const x = run();
	x.send(precedent);
	x.publishMandate({
		kind: "publish_mandate",
		draft: { ...draft, intent: goal },
		replies: [],
	});
	x.answer(x.asks()[0]!.subject, choice);
	return x;
}

test("neither cancelling an approved work nor declining a review exposes its Mandate or rulings", async () => {
	const cancelled = historicalReview("approve");
	cancelled.send({ kind: "cancel" });
	const declined = historicalReview("decline");
	for (const x of [cancelled, declined]) {
		const record = await explorerHistory([x], x);
		assert.deepEqual(record.priorWorks, []);
		assert.deepEqual(record.rulings, []);
		assert.equal(record.design, null);
	}
});

test("a follow work's applied revision gives explorers only the approved changed nodes, not its Mandate", async () => {
	const x = pending();
	x.send(publish);
	const [ask] = x.asks();
	assert.match(ask!.basis, /Emit one escaped line/);
	assert.doesNotMatch(ask!.basis, /Keep the report timestamp/);
	assert.deepEqual((await explorerHistory([x])).priorWorks, []);
	x.answer(ask!.subject, "approve");
	assert.deepEqual((await explorerHistory([x])).priorWorks, []);
	x.send(activated);
	const { priorWorks } = await explorerHistory([x]);
	assert.equal(priorWorks.length, 1);
	assert.equal(priorWorks[0]!.mandate, undefined);
	assert.deepEqual(priorWorks[0]!.revisionNodes, [
		{
			label: "R1",
			section: "Rule",
			body: correction.rule,
			probe: correction.probe,
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(priorWorks),
		/Emit one raw line|Keep the report timestamp|verify-report|Validate before writing/,
	);
});

test("explorers get full evidence for the newest three eligible works and a one-line-per-node index for older works", async () => {
	const reviewed = Array.from({ length: 4 }, (_, i) =>
		historicalReview(
			"approve",
			`Report work ${i + 1}\nAdditional goal detail.`,
		),
	);
	const record = await explorerHistory([
		...reviewed,
		historicalReview("decline"),
	]);
	assert.deepEqual(
		record.priorWorks.map((w) => w.work),
		[3, 4, 5],
	);
	assert.ok(
		record.priorWorks.every((w) => w.mandate && w.rulings.length === 1),
	);
	const [older] = record.earlierWorks;
	assert.equal(record.earlierWorks.length, 1);
	assert.ok(older);
	assert.equal(older.work, 2);
	assert.equal(older.goal, "Report work 1");
	assert.deepEqual(
		older.nodes.find((n) => n.label === "R1"),
		{
			label: "R1",
			line: "Emit one raw line.",
		},
	);
	assert.ok(older.nodes.every((n) => !n.line.includes("\n")));
	assert.doesNotMatch(
		JSON.stringify(older),
		/Additional goal detail|Validate before writing|Compare bytes/,
	);
});

function pending() {
	const x = run();
	x.send(follow);
	x.send(request);
	return x;
}

test("triage pins the route and authority; follow binds directly, precedent still needs review", () => {
	const x = run();
	x.send(seed);
	for (const part of [seed.text, reference])
		assert.ok(x.input().includes(part));
	for (const event of [
		{ ...follow, reference: "Unapproved examples" },
		precedent,
	])
		assert.ok("reject" in x.attempt(event));
	assert.equal(x.send(follow).send?.[0]?.event.kind, "bound");
	assert.deepEqual(x.asks(), []);

	const seeded = run();
	seeded.send({ ...seed, route: "precedent" });
	seeded.send({
		kind: "agent_stalled",
		agent: "designer",
		token: seeded.turn()!.token,
		cause: "stopped",
		lastWords: "Reading docs",
	});
	seeded.send(holdingChoice(seeded.asks()[0]!, "resume", "Check ADR 8."));
	assert.match(seeded.input(), /Check ADR 8/);
	assert.ok("reject" in seeded.attempt(follow));
	seeded.send(precedent);
	seeded.publishMandate({ kind: "publish_mandate", draft, replies: [] });
	assert.ok(seeded.asks()[0]?.basis.includes(seed.text));
	assert.equal(seeded.state().mandate, null);
});

test("revision review shows the delta; approval sends it but only matching activation binds it", () => {
	const x = pending();
	const old = x.mandate();
	x.send(publish);
	const [ask] = x.asks();
	for (const part of [
		request.text,
		rule.rule,
		correction.rule,
		correction.probe,
	])
		assert.ok(ask!.basis.includes(part), part);
	assert.ok(!ask!.basis.includes(untouched.rule));
	assert.deepEqual(x.mandate(), old);
	const at = ask!.basis.indexOf(correction.probe);
	const proposed = x.answer(ask!.subject, "approve", [
		{ ...note, range: { start: at, end: at + correction.probe.length } },
	]).send?.[0];
	const next = {
		...old,
		approvalNotes: [`${note.text}\n> ${correction.probe}`],
		nodes: [correction, untouched],
	};
	assert.equal(proposed?.lane, "build");
	assert.deepEqual(proposed?.event.mandate, next);
	assert.deepEqual(proposed?.event.causes, request.causes);
	for (const causes of [[request.causes[0]!], ["unrelated"]]) {
		x.send({ ...activated, causes });
		assert.deepEqual(x.mandate(), old);
	}
	x.send(activated);
	assert.deepEqual(x.mandate(), next);
});

test("a revision refuses invalid labels, malformed or duplicated edits", () => {
	const x = pending();
	for (const changes of [
		{ nodes: [{ ...rule, label: "intent" }] },
		{ nodes: [{ ...correction, probe: " " }] },
		{ nodes: [correction, correction] },
		{ checks: [{ ...small.checks[0]!, timeoutMs: 0 }] },
		{ remove: ["missing"] },
		{ remove: ["intent"] },
		{ remove: ["R1"], nodes: [correction] },
	]) {
		const result = x.attempt({ ...publish, changes });
		assert.ok("reject" in result, JSON.stringify(changes));
		assert.deepEqual(x.asks(), []);
	}
	assert.ok(
		"reject" in
			x.attempt({
				...publish,
				changes: { remove: ["P1"] },
				answers: answerCauses(request.causes, ["P1"]),
			}),
		"the revision must not remove the only timed proof",
	);
	x.send(publish);
	assert.equal(x.asks().length, 1);
});

test("a seam revision needs the usage-first contract and preserves proof, riders, and reference context", () => {
	const x = run();
	x.send(precedent);
	x.publishMandate({ kind: "publish_mandate", draft, replies: [] });
	x.answer(x.asks()[0]!.subject, "approve");
	const old = x.mandate();
	x.send({ ...request, nodes: ["S1"] });
	assert.ok(x.input().includes("Approved report probe ADR 9"));
	const changes = { seams: [{ ...seam, owner: "Export boundary" }] };
	const answers = answerCauses(request.causes, ["S1"]);
	assert.ok(
		"reject" in
			x.attempt({
				...publish,
				changes: { seams: [{ ...seam, signature: "plain" }] },
				answers,
			}),
	);
	assert.ok(
		"reject" in
			x.attempt({
				...publish,
				changes: {
					sections: [{ label: "S1", body: "Unstructured replacement" }],
				},
				answers,
			}),
		"a free-form note must not replace a seam contract",
	);
	x.send({ ...publish, changes, answers });
	const [ask] = x.asks();
	const text = ask!.basis;
	assert.ok(text.includes(seam.owner));
	assert.ok(text.includes("Export boundary"));
	assert.ok(text.indexOf(seam.usage) < text.indexOf(seam.signature));
	const next = x.answer(ask!.subject, "approve").send?.[0]?.event
		.mandate as typeof old;
	assert.deepEqual(next.checks, old.checks);
	assert.deepEqual(next.delegated, old.delegated);
	assert.deepEqual(next.considerations, old.considerations);
	assert.deepEqual(
		next.nodes.filter((n) => n.label !== "S1"),
		old.nodes.filter((n) => n.label !== "S1"),
	);
});

test("rework preserves numbered direction and issues a fresh review; a stalled revision resumes that turn with a new token", () => {
	const x = pending();
	x.send(publish);
	const first = x.asks()[0]!.subject;
	x.answer(first, "rework", [note]);
	assert.deepEqual(x.asks(), []);
	assert.ok(x.input().includes(`1. ${note.text}`));
	assert.ok("reject" in x.attempt(publish));
	const token = x.turn()!.token;
	x.send({
		kind: "agent_stalled",
		agent: "designer",
		token,
		cause: "failed",
		lastWords: "Checking the premise",
	});
	assert.equal(x.turn(), undefined);
	x.send(holdingChoice(x.asks()[0]!, "resume", "Use the fixture."));
	assert.deepEqual(x.turn()?.tools, ["publish_revision"]);
	assert.notEqual(x.turn()?.token, token);
	for (const part of [note.text, "Use the fixture."])
		assert.ok(x.input().includes(part));
	x.send({
		...request,
		causes: ["queue/3"],
		nodes: ["R2"],
		text: "The reader needs a UTC timestamp.",
	});
	for (const text of [note.text, "Use the fixture.", "UTC timestamp"])
		assert.ok(x.input().includes(text));
	const nextRule = {
		...correction,
		rule: "Round only once, after allocating fees.",
	};
	x.send({
		...publish,
		changes: {
			nodes: [nextRule, { ...untouched, rule: "Report timestamps in UTC." }],
		},
		answers: [...publish.answers, ...answerCauses(["queue/3"], ["R2"])],
		replies: [reply],
	});
	const second = x.asks()[0]!;
	assert.notEqual(first, second.subject);
	assert.ok(second.basis.includes(reply.reason));
	assert.match(second.basis, /Since round 1: R1 changed/);
	const [proposed, previous, duplicateBound] =
		second.basis.split("#### Previously");
	assert.equal(duplicateBound, undefined);
	assert.match(proposed!, /### R1: Rule \(changed\)/);
	assert.ok(proposed!.includes(nextRule.rule));
	assert.ok(previous?.includes(correction.rule));
	assert.ok(previous?.includes(correction.probe));
	assert.deepEqual(x.answer(first, "approve").send ?? [], []);
	assert.equal(x.asks()[0]?.subject, second.subject);
});

test("a cause joining review withdraws the unanswered text; the new review attributes both reports without inventing history", () => {
	const x = run();
	const [a, b] = request.causes as [string, string];
	x.send(follow);
	const old = x.mandate();
	x.send({
		...request,
		causes: [a],
		text: `### Finding #1: Raw values need framing\n${request.text}`,
	});
	x.send({ ...publish, answers: answerCauses([a], ["R1"]) });
	const first = x.asks()[0]!;
	const evidence = "### Finding #2: Name the clock\nThe reader needs a clock.";
	x.send({ ...request, causes: [b], nodes: ["R2"], text: evidence });
	assert.deepEqual(x.asks(), []);
	assert.ok(x.input().includes(evidence));
	assert.ok(x.input().includes(request.text));
	assert.deepEqual(x.answer(first.subject, "approve").send ?? [], []);
	x.send({
		...publish,
		changes: {
			nodes: [
				correction,
				{ ...untouched, rule: "Keep the UTC report timestamp." },
			],
		},
		answers: [
			...answerCauses(
				[a],
				["R1"],
				"Escaping keeps embedded newlines in the record.",
			),
			...answerCauses([b], ["R2"], "The contract identifies the clock as UTC."),
		],
	});
	const next = x.asks()[0]!;
	assert.notEqual(next.subject, first.subject);
	assert.ok(next.basis.includes(evidence));
	assert.ok(next.basis.includes(request.text));
	assert.match(
		next.basis,
		/Finding #1: Raw values need framing: R1\. Escaping/,
	);
	assert.match(next.basis, /Finding #2: Name the clock: R2\. The contract/);
	assert.doesNotMatch(next.basis, /Since round|Previously|preceding round/);
	const declined = x.answer(next.subject, "decline", [note]);
	assert.deepEqual(
		declined.send?.filter((m) => m.lane === "build").map((m) => m.event.cause),
		request.causes,
	);
	assert.equal(
		declined.send?.find((m) => m.lane === "queue")?.event.disposition,
		"revision declined",
	);
	assert.deepEqual(x.mandate(), old);
	assert.equal(x.turn(), undefined);
});

test("an already-settled proposal still owes numbered replies and releases causes only through approval and application", () => {
	const x = pending();
	const old = x.mandate();
	x.send(publish);
	x.answer(x.asks()[0]!.subject, "rework", [note]);
	const unchanged = {
		...publish,
		changes: {},
		answers: [
			...answerCauses(
				[request.causes[0]!],
				["P1"],
				"The existing proof compares the serialized bytes.",
			),
			...answerCauses(
				[request.causes[1]!],
				["R1"],
				"The rule governs the emitted record, not the input.",
			),
		],
	};
	assert.ok("reject" in x.attempt(unchanged));
	assert.equal(x.asks().length, 0);
	assert.deepEqual(x.send({ ...unchanged, replies: [reply] }).send ?? [], []);
	const ask = x.asks()[0]!;
	assert.match(ask.basis, /Since round 1: R1 reverted to bound/);
	assert.doesNotMatch(ask.basis, /Removed since the last round/);
	for (const detail of [
		note.text,
		reply.reason,
		"No change",
		"Finding #1: P1",
		"Finding #2: R1",
		"compares the serialized bytes",
		old.checks[0]!.argv[0]!,
	])
		assert.ok(ask.basis.includes(detail), detail);
	const approval = x.answer(ask.subject, "approve", [note]);
	assert.deepEqual(
		approval.send?.map((m) => m.event.kind),
		["propose_revision"],
	);
	assert.deepEqual(approval.send?.[0]?.event.causes, request.causes);
	assert.deepEqual(approval.send?.[0]?.event.nodes, []);
	assert.deepEqual(x.mandate(), old);
	const applied = x.send({
		kind: "revision_activated",
		causes: request.causes,
	});
	assert.deepEqual(applied.send?.[0]?.event.causes, request.causes);
	assert.match(
		String(applied.send?.[0]?.event.disposition),
		/no Mandate change/i,
	);
	assert.deepEqual(x.mandate(), { ...old, approvalNotes: [note.text] });
	assert.equal(x.turn(), undefined);
	const summary = (x.view() as { revisionSummary: string }).revisionSummary;
	assert.match(summary, /Revision 1: No Mandate change/);
	assert.match(
		summary,
		/Finding #1: P1\. The existing proof compares the serialized bytes/,
	);
	assert.match(summary, /Finding #2: R1\. The rule governs the emitted record/);
});

test("revision proposals refuse missing, duplicate or foreign answers, unknown labels, blank reasons and unattributed edits", () => {
	const x = pending();
	const [a, b] = request.causes as [string, string];
	for (const answers of [
		[],
		answerCauses([a], ["R1"]),
		answerCauses([a, a], ["R1"]),
		answerCauses([a, "unknown"], ["R1"]),
		answerCauses([a, b], ["unknown"]),
		answerCauses([a, b], ["R1"], " "),
		answerCauses([a, b], ["R2"]),
	])
		assert.ok(
			"reject" in x.attempt({ ...publish, answers }),
			JSON.stringify(answers),
		);
	assert.ok(
		"reject" in
			x.attempt({
				...publish,
				changes: {},
				answers: answerCauses([a, b], ["unknown"]),
			}),
	);
	assert.deepEqual(x.asks(), []);
});

test("a cited label cannot be removed, whether an item is preparing or already recorded", () => {
	for (const stage of ["preparing", "merged"]) {
		const x = run({
			...world,
			view: (lane) =>
				lane === "build"
					? {
							plan: [
								{ id: "stats", goal: "Write statistics", stage, nodes: ["R2"] },
							],
						}
					: null,
		});
		x.send(follow);
		x.send(request);
		const answers = answerCauses(request.causes, ["R2"]);
		const result = x.attempt({
			...publish,
			changes: { remove: ["R2"] },
			answers,
		});
		assert.ok("reject" in result);
		assert.match(result.reject, /Item stats .*cites R2/);
		x.send({
			...publish,
			changes: { nodes: [{ ...untouched, rule: "Use UTC." }] },
			answers,
		});
		assert.match(
			x.asks()[0]!.basis,
			stage === "merged" ? /record; add a correction/ : /replan/,
		);
	}
});

test("a revision distinguishes changes, additions and removals of uncited labels", () => {
	const x = pending();
	x.send({
		...publish,
		changes: {
			nodes: [correction, { ...untouched, label: "R3" }],
			remove: ["R2"],
		},
		answers: answerCauses(request.causes, ["R1", "R2", "R3"]),
	});
	const ask = x.asks()[0]!;
	assert.match(ask.basis, /R3: Rule \(new\)/);
	assert.match(ask.basis, /R2[^\n]*removed/i);
	assert.match(
		ask.basis,
		/R1: Rule \(changed\)\n\nChanged: rule, falsifying probe/,
	);
	const approval = x.answer(ask.subject, "approve").send?.[0]?.event;
	assert.deepEqual(approval?.nodes, ["R1", "R2", "R3"]);
	x.send(activated);
	assert.deepEqual(
		x.mandate().nodes.map((n) => n.label),
		["R1", "R3"],
	);
});

test("triage evidence remains usable when an intervening revision removed a reported label", () => {
	const x = pending();
	x.send({
		...publish,
		changes: { remove: ["R2"] },
		answers: answerCauses(request.causes, ["R2"]),
	});
	x.answer(x.asks()[0]!.subject, "approve");
	x.send(activated);
	x.send({
		...request,
		causes: ["finding-8"],
		nodes: ["R2"],
		text: "The old timestamp report.",
	});
	assert.match(x.input(), /The old timestamp report/);
	x.send({
		...publish,
		changes: {},
		answers: answerCauses(["finding-8"], ["R1"]),
	});
	assert.match(x.asks()[0]!.basis, /finding-8: R1/);
});

test("causes after approval wait without changing it, then join the next revision against the newly bound Mandate", () => {
	const x = pending();
	x.send(publish);
	const first = x.asks()[0]!;
	const approval = x.answer(first.subject, "approve", [note]);
	assert.deepEqual(
		(approval.send?.[0]?.event.mandate as { approvalNotes: string[] })
			.approvalNotes,
		[note.text],
	);
	const late = ["queue/5", "queue/6"];
	for (const cause of late) {
		const waiting = x.send({
			...request,
			causes: [cause],
			text: `Late evidence ${cause}.`,
		});
		assert.deepEqual(waiting.send ?? [], []);
		assert.equal(x.turn(), undefined);
		assert.deepEqual(x.asks(), []);
	}
	x.send({ kind: "revision_activated", causes: [...request.causes, ...late] });
	assert.equal(x.turn(), undefined);
	const applied = x.send({
		kind: "revision_activated",
		causes: request.causes,
	});
	assert.deepEqual(applied.send?.[0]?.event.causes, request.causes);
	assert.deepEqual(x.mandate().nodes[0], correction);
	for (const cause of late)
		assert.ok(x.input().includes(`Late evidence ${cause}.`));
	assert.ok(x.input().includes(correction.rule));
	const nextRule = {
		...correction,
		rule: "Emit one escaped line, followed by the checksum.",
	};
	x.send({
		...publish,
		changes: { nodes: [nextRule] },
		answers: answerCauses(late, ["R1"]),
	});
	const next = x.asks()[0]!;
	assert.notEqual(next.subject, first.subject);
	const approved = x.answer(next.subject, "approve").send?.[0]?.event;
	assert.deepEqual(approved?.causes, late);
	assert.equal(approved?.number, 2);
	assert.deepEqual(
		(approved?.mandate as { approvalNotes: string[] }).approvalNotes,
		[],
	);
});

test("cancel names the current rework annotation as not pursued, and omits a reply already given", () => {
	const x = run();
	x.send(precedent);
	const first = { kind: "publish_mandate", draft, replies: [] };
	x.publishMandate(first);
	x.answer(x.asks()[0]!.subject, "rework", [
		{ ...note, text: "Already answered in round 2." },
	]);
	x.publishMandate({ ...first, replies: [reply] });
	x.answer(x.asks()[0]!.subject, "rework", [note]);
	const cancellation = x.send({ kind: "cancel" });
	assert.match(
		cancellation.notes?.[0]?.text ?? "",
		/Keep escapes readable\.[^\n]*not pursued/i,
	);
	assert.doesNotMatch(cancellation.notes![0]!.text, /Already answered/);
	assert.deepEqual(x.send({ kind: "cancel" }).notes ?? [], []);
});

test("cancel names approval notes as not pursued only before their plan is written", () => {
	for (const hasPlan of [false, true]) {
		const x = run({
			...world,
			view: () => ({ plan: hasPlan ? [{ id: "report" }] : [] }),
		});
		x.send(precedent);
		x.publishMandate({ kind: "publish_mandate", draft, replies: [] });
		x.answer(x.asks()[0]!.subject, "approve", [note]);
		const text =
			x
				.send({ kind: "cancel" })
				.notes?.map((n) => n.text)
				.join("\n") ?? "";
		if (hasPlan) assert.doesNotMatch(text, /Keep escapes readable/);
		else assert.match(text, /Keep escapes readable\.[^\n]*not pursued/i);
	}
});

test("cancel names outstanding direction from a live revision before the plan applies", () => {
	for (const choice of ["approve", "rework"]) {
		const x = pending();
		x.send(publish);
		x.answer(x.asks()[0]!.subject, choice, [note]);
		const notes =
			x
				.send({ kind: "cancel" })
				.notes?.map((n) => n.text)
				.join("\n") ?? "";
		assert.match(notes, /Keep escapes readable\.[^\n]*not pursued/i);
	}
});

test("late revision messages cannot reopen terminal work", () => {
	for (const kind of ["cancel", "closed", "landed"]) {
		const x = pending();
		const old = x.mandate();
		x.send(publish);
		const [ask] = x.asks();
		x.send({ kind });
		x.send({ ...request, causes: ["finding-3"] });
		x.send({
			kind: "revision_activated",
			causes: request.causes,
		});
		assert.deepEqual(x.answer(ask!.subject, "approve").send ?? [], []);
		assert.deepEqual(x.mandate(), old);
		assert.deepEqual(x.asks(), []);
		assert.equal(x.turn(), undefined);
	}
});
