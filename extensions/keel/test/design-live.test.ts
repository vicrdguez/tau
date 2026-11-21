import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import {
	challengeReview,
	crossFamilyOptions,
	frameReview,
	reviewChoices,
	synthesis,
} from "./fixtures/design-review.ts";
import { drive } from "./fixtures/drive.ts";

const work = 12 as WorkId;
const world: World = {
	work,
	root: "/project",
	now: 1,
	view: () => null,
	options: {
		design: "a/a",
		...crossFamilyOptions,
		build: "b/b",
		verify: "v/v",
		queue: "q/q",
		base: "main",
		trunk: "trunk",
		max_workers: 2,
	},
};
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
	causes: ["finding-1", "finding-2"],
	nodes: ["R1"],
	text: "F9 reproduces a report split on an embedded newline at abc123.",
};
const publish = {
	kind: "publish_revision",
	changes: { nodes: [correction] },
	replies: [],
};
const reply = { n: 1, status: "acted_on", reason: "Test a tab too." };
const note = { n: 1, text: "Keep escapes readable." };

function run(facts = world) {
	let state = design.state.initial();
	const send = (event: LaneEvent) => drive(design, state, event, facts);
	const act = (event: LaneEvent) => {
		const result = send(event);
		assert.ok("state" in result, JSON.stringify(result));
		state = result.state;
		return result;
	};
	const driver = { act, state: () => state };
	const publishMandate = (event: LaneEvent) => {
		if (state.phase === "framing") frameReview(driver, facts);
		act({ ...synthesis, ...event });
		challengeReview(driver, facts);
	};
	const asks = () => design.asks(state, world);
	const answer = (
		subject: string,
		choice: string,
		annotations: (typeof note & {
			range?: { start: number; end: number };
		})[] = [],
	) =>
		act({
			kind: "answered",
			subject,
			decision: `${subject}#1`,
			choice,
			annotations,
		});
	const turn = () => design.agents(state, world)[0]?.expects[0];
	return {
		send,
		act,
		publishMandate,
		asks,
		answer,
		turn,
		input: () => turn()?.input?.() ?? "",
		mandate: () => state.mandate!,
	};
}

function pending() {
	const x = run();
	x.act(follow);
	x.act(request);
	return x;
}

test("a queue follow seed pins the route and authority, and binds without a second owner decision", () => {
	const x = run();
	x.act(seed);
	assert.deepEqual(x.turn()?.tools, ["ground"]);
	for (const part of [seed.text, reference])
		assert.ok(x.input().includes(part));
	for (const event of [
		{ ...follow, reference: "Unapproved examples" },
		{ kind: "ground", route: "precedent", reference, audit },
		{ kind: "ground", route: "ambiguous", reference, readings: ["A", "B"] },
	])
		assert.ok("reject" in x.send(event));
	const bound = x.act(follow);
	assert.deepEqual(x.asks(), []);
	assert.equal(x.turn(), undefined);
	assert.deepEqual(bound.send, [
		{ lane: "build", work, event: { kind: "bound", mandate: x.mandate() } },
	]);
	assert.equal(x.mandate().encodeRequired, false);
});

test("a queue precedent seed survives a stopped Ground and enters audited Mandate review", () => {
	const x = run();
	x.act({ ...seed, route: "precedent" });
	const token = x.turn()!.token;
	const stopped = x.act({
		kind: "agent_stalled",
		agent: "designer",
		tokens: [token],
		cause: "stopped",
		lastWords: "Reading docs",
	});
	assert.equal(x.turn(), undefined);
	x.act({
		kind: "resume",
		cause: stopped.send![0]!.event.cause!,
		evidence: "Reading docs",
		direction: "Check ADR 8.",
	});
	assert.notEqual(x.turn()?.token, token);
	for (const part of [seed.text, seed.reference, "Check ADR 8."])
		assert.ok(x.input().includes(part));
	assert.ok("reject" in x.send(follow));
	assert.ok(
		"reject" in x.send({ kind: "ground", route: "precedent", reference }),
	);
	x.act({ kind: "ground", route: "precedent", reference, audit });
	assert.match(x.input(), /shell writer/);
	assert.ok(x.input().includes(seed.text));
	x.publishMandate({ kind: "publish_mandate", draft, replies: [] });
	assert.deepEqual(x.asks()[0]?.choices, reviewChoices);
	assert.equal(x.mandate(), null);
});

test("revision review is a delta, and approval binds only on acknowledgement of that exact plan's Mandate", () => {
	const x = pending();
	const old = x.mandate();
	const turn = x.turn();
	assert.deepEqual(turn?.tools, ["publish_revision", "revision_settled"]);
	for (const part of [request.text, "R1", rule.rule])
		assert.ok(x.input().includes(part));
	assert.deepEqual(x.asks(), []);
	x.act(publish);
	const [ask] = x.asks();
	assert.deepEqual(ask?.choices, ["approve", "rework", "decline"]);
	for (const part of [
		request.text,
		rule.rule,
		correction.rule,
		correction.probe,
	])
		assert.ok(ask!.basis.includes(part), part);
	assert.ok(!ask!.basis.includes(untouched.rule));
	assert.doesNotMatch(
		ask!.basis,
		/\(new\)|previous round|last round|preceding round/i,
	);
	assert.deepEqual(x.mandate(), old);
	const at = ask!.basis.indexOf(correction.probe);
	const approved = x.answer(ask!.subject, "approve", [
		{ ...note, range: { start: at, end: at + correction.probe.length } },
	]);
	const next = {
		...old,
		approvalNotes: [`${note.text}\n> ${correction.probe}`],
		nodes: [correction, untouched],
	};
	assert.deepEqual(approved.send, [
		{
			lane: "build",
			work,
			event: { ...request, kind: "propose_revision", mandate: next },
		},
	]);
	assert.deepEqual(x.mandate(), old);
	assert.deepEqual(x.asks(), []);
	assert.deepEqual(x.answer(ask!.subject, "approve").send ?? [], []);
	x.act({ kind: "revision_activated", causes: [request.causes[0]!] });
	assert.deepEqual(x.mandate(), old);
	x.act({ kind: "revision_activated", causes: ["unrelated"] });
	assert.deepEqual(x.mandate(), old);
	x.act({ kind: "revision_activated", causes: request.causes });
	assert.deepEqual(x.mandate(), next);
});

test("a revision refuses empty, unchanged, malformed or duplicated edits", () => {
	const x = pending();
	for (const changes of [
		{},
		{ nodes: [rule] },
		{ nodes: [{ ...correction, probe: " " }] },
		{ nodes: [correction, correction] },
		{ checks: [{ ...small.checks[0]!, timeoutMs: 0 }] },
		{ remove: ["missing"] },
		{ remove: ["intent"] },
		{ remove: ["R1"], nodes: [correction] },
	]) {
		const result = x.send({ ...publish, changes });
		assert.ok("reject" in result, JSON.stringify(changes));
		assert.deepEqual(x.asks(), []);
	}
	x.act(publish);
	assert.equal(x.asks().length, 1);
});

test("a seam revision needs the usage-first contract and preserves proof, riders, and reference context", () => {
	const x = run();
	x.act({ kind: "ground", route: "precedent", reference, audit });
	x.publishMandate({ kind: "publish_mandate", draft, replies: [] });
	x.answer(x.asks()[0]!.subject, "approve");
	const old = x.mandate();
	x.act({ ...request, nodes: ["S1"] });
	assert.ok(x.input().includes("Approved report probe ADR 9"));
	assert.ok(x.input().includes("Keep the old file name."));
	for (const patch of [
		{ usage: "plain" },
		{ signature: "plain" },
		{ callersLater: " " },
	]) {
		assert.ok(
			"reject" in
				x.send({
					...publish,
					changes: { seams: [{ ...seam, owner: "Export boundary", ...patch }] },
				}),
		);
	}
	x.act({
		...publish,
		changes: { seams: [{ ...seam, owner: "Export boundary" }] },
	});
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
	x.act(publish);
	const first = x.asks()[0]!.subject;
	x.answer(first, "rework", [note]);
	assert.deepEqual(x.asks(), []);
	assert.ok(x.input().includes(`1. ${note.text}`));
	assert.ok("reject" in x.send(publish));
	const token = x.turn()!.token;
	const stalled = x.act({
		kind: "agent_stalled",
		agent: "designer",
		tokens: [token],
		cause: "failed",
		lastWords: "Checking the premise",
	});
	assert.equal(x.turn(), undefined);
	x.act({
		kind: "resume",
		cause: stalled.send![0]!.event.cause!,
		evidence: "Check the premise",
		direction: "Use the fixture.",
	});
	assert.deepEqual(x.turn()?.tools, ["publish_revision", "revision_settled"]);
	assert.notEqual(x.turn()?.token, token);
	for (const part of [note.text, "Use the fixture."])
		assert.ok(x.input().includes(part));
	const nextRule = {
		...correction,
		rule: "Round only once, after allocating fees.",
	};
	x.act({ ...publish, changes: { nodes: [nextRule] }, replies: [reply] });
	const second = x.asks()[0]!;
	assert.notEqual(first, second.subject);
	assert.ok(second.basis.includes(reply.reason));
	assert.match(second.basis, /Since round 1: R1 changed/);
	const [proposed, previous] = second.basis.split("#### Previously");
	assert.match(proposed!, /### R1: Rule \(changed\)/);
	assert.ok(proposed!.includes(nextRule.rule));
	assert.ok(previous?.includes(correction.rule));
	assert.ok(previous?.includes(correction.probe));
	assert.deepEqual(x.answer(first, "approve").send ?? [], []);
	assert.equal(x.asks()[0]?.subject, second.subject);
});

test("build answers join an open revision, and declining releases all joined causes", () => {
	const x = pending();
	const old = x.mandate();
	x.act(publish);
	const first = x.asks()[0]!;
	const second = {
		...request,
		causes: ["finding-3"],
		text: "Another report about the same node.",
	};
	x.act(second);
	assert.deepEqual(x.asks(), []);
	assert.match(x.input(), /Another report about the same node/);
	assert.ok(x.input().includes(request.text));
	assert.deepEqual(x.answer(first.subject, "approve").send ?? [], []);
	x.act(publish);
	const declined = x.answer(x.asks()[0]!.subject, "decline", [note]);
	assert.deepEqual(
		declined.send?.filter((m) => m.lane === "build").map((m) => m.event.cause),
		[...request.causes, ...second.causes],
	);
	assert.equal(
		declined.send?.find((m) => m.lane === "queue")?.event.disposition,
		"revision declined",
	);
	assert.deepEqual(x.mandate(), old);
	assert.equal(x.turn(), undefined);
	const third = {
		...request,
		text: "New cause on the ledger.",
		causes: ["finding-4"],
	};
	x.act(third);
	assert.match(x.input(), /New cause on the ledger/);
	assert.doesNotMatch(x.input(), /Another report about the same node/);
});

test("a cause already answered by a bound node needs no owner decision and releases only that cause", () => {
	const x = pending();
	x.act({ ...request, causes: ["finding-3"], text: "The second concern." });
	const token = x.turn()!.token;
	const settlement = {
		kind: "revision_settled",
		cause: "finding-3",
		node: "R1",
	};
	assert.ok("reject" in x.send({ ...settlement, node: "unknown" }));
	assert.ok("reject" in x.send({ ...settlement, cause: "unknown" }));
	const result = x.act(settlement);
	assert.deepEqual(
		result.send?.filter((m) => m.lane === "build").map((m) => m.event.cause),
		["finding-3"],
	);
	assert.equal(
		result.send?.find((m) => m.lane === "queue")?.event.disposition,
		"already settled by R1",
	);
	assert.notEqual(x.turn()?.token, token);
	assert.deepEqual(x.asks(), []);
	x.act(publish);
	const approved = x.answer(x.asks()[0]!.subject, "approve").send?.[0]?.event;
	assert.deepEqual(approved?.causes, request.causes);
});

test("a revision shows and applies all differences, including an unreported addition and removal", () => {
	const x = pending();
	x.act({
		...publish,
		changes: {
			nodes: [correction, { ...untouched, label: "R3" }],
			remove: ["R2"],
		},
	});
	const ask = x.asks()[0]!;
	assert.match(ask.basis, /R3: Rule \(new\)/);
	assert.match(ask.basis, /R2[^\n]*removed/i);
	assert.match(ask.basis, /Changed: rule, falsifying probe/);
	assert.doesNotMatch(ask.basis, /R1: Rule \(new\)/);
	const approval = x.answer(ask.subject, "approve").send?.[0]?.event;
	assert.deepEqual(approval?.nodes, ["R1", "R2", "R3"]);
	assert.deepEqual(
		(approval?.mandate as { nodes: { label: string }[] }).nodes.map(
			(n) => n.label,
		),
		["R1", "R3"],
	);
});

test("a cause arriving while the approved plan is owed withdraws that plan and returns to the designer", () => {
	const x = pending();
	x.act(publish);
	x.answer(x.asks()[0]!.subject, "approve", [note]);
	const joined = x.act({
		...request,
		causes: ["finding-5"],
		text: "Evidence before activation.",
	});
	assert.equal(joined.send?.[0]?.event.kind, "withdraw_revision");
	assert.match(x.input(), /Evidence before activation/);
	x.act(publish);
	const approved = x.answer(x.asks()[0]!.subject, "approve").send?.[0]?.event;
	assert.deepEqual(approved?.causes, [...request.causes, "finding-5"]);
	assert.equal(
		(approved?.mandate as { approvalNotes: string[] }).approvalNotes.length,
		1,
	);
});

test("cancel names the current rework annotation as not pursued, and omits a reply already given", () => {
	const x = run();
	x.act({ kind: "ground", route: "precedent", reference, audit });
	const first = { kind: "publish_mandate", draft, replies: [] };
	x.publishMandate(first);
	x.answer(x.asks()[0]!.subject, "rework", [
		{ ...note, text: "Already answered in round 2." },
	]);
	x.publishMandate({ ...first, replies: [reply] });
	x.answer(x.asks()[0]!.subject, "rework", [note]);
	const cancellation = x.act({ kind: "cancel" });
	assert.match(
		cancellation.notes?.[0]?.text ?? "",
		/Keep escapes readable\.[^\n]*not pursued/i,
	);
	assert.doesNotMatch(cancellation.notes![0]!.text, /Already answered/);
	assert.deepEqual(x.act({ kind: "cancel" }).notes ?? [], []);
});

test("cancel names approval notes as not pursued only before their plan is written", () => {
	for (const hasPlan of [false, true]) {
		const x = run({
			...world,
			view: () => ({ plan: hasPlan ? [{ id: "report" }] : [] }),
		});
		x.act({ kind: "ground", route: "precedent", reference, audit });
		x.publishMandate({ kind: "publish_mandate", draft, replies: [] });
		x.answer(x.asks()[0]!.subject, "approve", [note]);
		const text =
			x
				.act({ kind: "cancel" })
				.notes?.map((n) => n.text)
				.join("\n") ?? "";
		if (hasPlan) assert.doesNotMatch(text, /Keep escapes readable/);
		else assert.match(text, /Keep escapes readable\.[^\n]*not pursued/i);
	}
});

test("cancel names outstanding direction from a live revision before the plan applies", () => {
	for (const choice of ["approve", "rework"]) {
		const x = pending();
		x.act(publish);
		x.answer(x.asks()[0]!.subject, choice, [note]);
		const notes =
			x
				.act({ kind: "cancel" })
				.notes?.map((n) => n.text)
				.join("\n") ?? "";
		assert.match(notes, /Keep escapes readable\.[^\n]*not pursued/i);
	}
});

for (const kind of ["cancel", "closed", "landed"]) {
	test(`late revision messages cannot reopen a ${kind} work`, () => {
		const x = pending();
		const old = x.mandate();
		x.act(publish);
		const [ask] = x.asks();
		x.act({ kind });
		x.act({ ...request, causes: ["finding-3"] });
		x.act({
			kind: "revision_activated",
			causes: request.causes,
		});
		assert.deepEqual(x.answer(ask!.subject, "approve").send ?? [], []);
		assert.deepEqual(x.mandate(), old);
		assert.deepEqual(x.asks(), []);
		assert.equal(x.turn(), undefined);
	});
}
