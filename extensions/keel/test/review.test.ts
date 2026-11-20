import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import { mandateLabels } from "../src/lanes/design/public.ts";
import { drive } from "./fixtures/drive.ts";

const world: World = {
	work: 12 as WorkId,
	root: "/repo",
	now: 1,
	view: () => null,
	options: {
		design: "x/x",
		build: "x/x",
		verify: "x/x",
		queue: "x/x",
		base: "main",
		trunk: "trunk",
		max_workers: 1,
	},
};
const audit = {
	exists: "The importer builds documents.",
	gaps: [{ label: "G1", text: "The DSL has no native constructor." }],
	contradictions: [
		{ label: "C1", text: "The glossary and ADR disagree about JSON." },
	],
};
const start = {
	kind: "ground",
	route: "precedent",
	reference: "Native construction",
	audit,
};
const seam = {
	label: "S1",
	callersNow: "Importer",
	callersLater: "DSL compiler",
	usage: "```ts\ncreate(op);\n```",
	signature: "```ts\nfunction create(op: Op): IR;\n```",
	owner: "IR",
	dependencies: "No frontend imports.",
};
const rule = {
	label: "R1",
	rule: "One representation.",
	probe: "Count the encodings.",
};
const draft = {
	intent: "Compile to native IR",
	done: "The DSL builds the same IR as the importer.",
	seams: [seam],
	nodes: [rule],
	never: "A second encoding.",
	tradeoffs: "Explicit builders for static checking.",
	alternatives: "JSON round trip couples native callers to IO.",
	settlements: [
		{ label: "G1", ruling: "Add a builder." },
		{ label: "C1", ruling: "ADR governs the glossary." },
	],
	checks: [{ id: "P1", argv: ["check", "same IR"], timeoutMs: 90 }],
	protectedPaths: ["tests/**"],
	riders: [
		{ label: "A", text: "Validate at close.", origin: "evidence" },
		{ label: "B", text: "Sort imports.", origin: "incidental" },
		{ label: "C", text: "Seal regions.", origin: "seeded" },
	],
	references: [{ label: "P1", source: "Proof ADR" }],
};
const note = (n: number, text: string) => ({
	n,
	text,
	range: { start: n, end: n + 3 },
});
const reply = (n: number) => ({
	n,
	status: "considered",
	reason: "See the revised ruling.",
});
function run() {
	let state = design.state.initial();
	const reduce = (event: LaneEvent) => drive(design, state, event, world);
	const act = (event: LaneEvent) => {
		const result = reduce(event);
		assert.ok("state" in result, JSON.stringify(result));
		state = result.state;
		return result;
	};
	const publish = (d = draft, replies: ReturnType<typeof reply>[] = []) =>
		act({ kind: "publish_mandate", draft: d, replies });
	const answer = (
		subject: string,
		choice: string,
		annotations: ReturnType<typeof note>[] = [],
	) =>
		act({
			kind: "answered",
			subject,
			choice,
			decision: `${subject}#7`,
			annotations,
		});
	const asks = () => design.asks(state, world);
	const input = () =>
		design.agents(state, world)[0]?.expects[0]?.input?.() ?? "";
	return { state: () => state, reduce, act, publish, answer, asks, input };
}
function review() {
	const x = run();
	x.act(start);
	x.publish();
	return x;
}

test("Ground requires an audit and unique observations before opening the designer's draft turn", () => {
	const x = run();
	for (const invalid of [
		null,
		{ ...audit, exists: " " },
		{ ...audit, gaps: audit.contradictions },
	])
		assert.ok("reject" in x.reduce({ ...start, audit: invalid }));
	x.act(start);
	assert.equal(
		design.agents(x.state(), world)[0]?.expects[0]?.situation,
		"shape",
	);
	assert.deepEqual(x.asks(), []);
	for (const value of [
		audit.exists,
		audit.gaps[0]!.text,
		audit.contradictions[0]!.text,
	])
		assert.ok(x.input().includes(value));
});
test("a draft needs every Ground ruling, unique labels, callers, usage and signature, probes, proof, alternatives and origins", () => {
	const x = run();
	x.act(start);
	for (const patch of [
		{ settlements: draft.settlements.slice(1) },
		{ seams: [{ ...seam, callersLater: " " }] },
		{ seams: [{ ...seam, signature: "call this" }] },
		{ seams: [{ ...seam, usage: "plain" }] },
		{ nodes: [{ ...rule, probe: " " }] },
		{ checks: [] },
		{ checks: [{ ...draft.checks[0], timeoutMs: 0 }] },
		{ alternatives: " " },
		{ riders: [{ ...draft.riders[0], origin: "owner" }] },
		{ riders: [{ ...draft.riders[0], label: "S1" }] },
		{ references: [{ label: "G1", source: "a pattern" }] },
	])
		assert.ok(
			"reject" in
				x.reduce({
					kind: "publish_mandate",
					draft: { ...draft, ...patch },
					replies: [],
				}),
			JSON.stringify(patch),
		);
});
test("one annotatable Mandate shows Ground rulings, usage before signatures, determined context and three separate rider decisions", () => {
	const x = review();
	const [main, ...riders] = x.asks();
	assert.deepEqual(main!.choices, ["approve", "rework", "decline"]);
	assert.deepEqual(
		riders.map((a) => a.choices),
		Array(3).fill(["accept", "leave_open", "design"]),
	);
	const basis = main!.basis;
	for (const value of [
		audit.exists,
		audit.gaps[0]!.text,
		audit.contradictions[0]!.text,
		...draft.settlements.map((v) => v.ruling),
		draft.intent,
		draft.done,
		...Object.values(seam),
		rule.probe,
		draft.never,
		draft.tradeoffs,
		draft.alternatives,
		"same IR",
		"90",
		"tests/**",
		".keel/**",
		"Proof ADR",
		...draft.riders.map((r) => r.text),
	])
		assert.ok(basis.includes(value), value);
	assert.ok(basis.indexOf(seam.usage) < basis.indexOf(seam.signature));
	assert.ok(!x.state().rounds[0]!.labels.includes("P1"));
});
test("approving with outstanding riders cannot bind; acceptance and delegation settle only their own rider", () => {
	const x = review();
	const anchor = x.asks()[0]!.basis.indexOf(rule.probe);
	const approved = x.answer("mandate/1", "approve", [
		{
			n: 1,
			text: "Use exact counts.",
			range: { start: anchor, end: anchor + rule.probe.length },
		},
	]);
	assert.equal(approved.send?.length ?? 0, 0);
	assert.equal(x.state().mandate, null);
	assert.equal(x.asks().length, 3);
	x.answer("rider/1/A", "accept");
	x.answer("rider/1/B", "leave_open");
	const result = x.answer("rider/1/C", "accept");
	assert.equal(result.send?.length, 1);
	const m = x.state().mandate!;
	assert.equal(m.reviewed, true);
	assert.equal(m.encodeRequired, true);
	assert.deepEqual(m.approvalNotes, [`Use exact counts.\n> ${rule.probe}`]);
	assert.deepEqual(m.delegated, [{ label: "B", text: "Sort imports." }]);
	assert.deepEqual(
		m.nodes.find((n) => n.label === "R1"),
		rule,
	);
	const s = m.nodes.find((n) => n.label === "S1");
	assert.ok(
		s && "section" in s && s.section === "Seam" && s.body.includes(seam.usage),
	);
	const labels = mandateLabels(m);
	for (const l of ["S1", "R1", "A", "C", "G1", "C1"])
		assert.ok(labels.includes(l));
	assert.ok(!labels.includes("B"));
	assert.equal(x.answer("rider/1/C", "accept").send?.length ?? 0, 0);
});
test("accepting an incidental choice does not manufacture an Encode obligation without a seam or rule", () => {
	const x = run();
	x.act({
		...start,
		audit: { exists: "Reports use plain text.", gaps: [], contradictions: [] },
	});
	x.publish({
		...draft,
		seams: [],
		nodes: [],
		settlements: [],
		riders: [draft.riders[1]!],
	});
	x.answer("rider/1/B", "accept");
	x.answer("mandate/1", "approve");
	const m = x.state().mandate!;
	assert.ok(mandateLabels(m).includes("B"));
	assert.equal(m.encodeRequired, false);
});
test("rework preserves ranges and refuses missing, duplicate, extra, invalid or empty replies; a removed rider's answer is stale", () => {
	const x = review();
	const annotations = [note(1, "Prefer native."), note(2, "Explain the cost.")];
	x.answer("mandate/1", "rework", annotations);
	assert.deepEqual(x.asks(), []);
	for (const n of annotations) assert.ok(x.input().includes(n.text));
	const revised = { ...draft, riders: draft.riders.slice(0, 2) };
	for (const replies of [
		[reply(1)],
		[reply(2), reply(2)],
		[reply(1), reply(2), reply(3)],
		[reply(1), { ...reply(2), status: "ignored" }],
		[reply(1), { ...reply(2), reason: " " }],
	])
		assert.ok(
			"reject" in
				x.reduce({ kind: "publish_mandate", draft: revised, replies }),
		);
	x.publish(revised, [reply(2), reply(1)]);
	assert.equal(x.state().rounds.length, 2);
	assert.deepEqual(x.state().rounds[0]!.answer?.annotations, annotations);
	assert.deepEqual(x.state().rounds[0]!.draft, draft);
	const basis = x.asks()[0]!.basis;
	for (const n of annotations) assert.ok(basis.includes(n.text));
	assert.ok(basis.includes(reply(1).reason));
	const before = x.state();
	x.answer("rider/1/C", "accept");
	assert.deepEqual(x.state(), before);
});
test("a redesigned rider and changed node need approval again; unchanged nodes and rider dispositions carry across rounds", () => {
	const x = review();
	x.answer("mandate/1", "approve", [note(1, "Old approval note.")]);
	x.answer("rider/1/A", "accept");
	x.answer("rider/1/B", "leave_open");
	x.answer("rider/1/C", "design", [note(1, "Separate close from seal.")]);
	assert.ok(x.input().includes("Separate close from seal."));
	assert.ok(x.input().includes("Seal regions."));
	assert.ok(
		"reject" in
			x.reduce({
				kind: "publish_mandate",
				draft: { ...draft, riders: [] },
				replies: [reply(1)],
			}),
	);
	const revised = {
		...draft,
		riders: draft.riders.slice(0, 2),
		nodes: [rule, { ...rule, label: "C", rule: "Seal explicitly." }],
		seams: [{ ...seam, owner: "Native IR" }],
	};
	x.publish(revised, [reply(1)]);
	assert.deepEqual(
		x.asks().map((a) => a.subject),
		["mandate/2"],
	);
	assert.deepEqual([...x.state().rounds[1]!.labels].sort(), ["C", "S1"]);
	assert.ok(x.asks()[0]!.basis.includes("Native IR"));
	assert.match(x.asks()[0]!.basis, /A \(evidence; accept\)/);
	assert.match(x.asks()[0]!.basis, /B \(incidental; leave_open\)/);
	x.answer("mandate/2", "approve", [note(1, "New approval note.")]);
	assert.deepEqual(x.state().mandate!.approvalNotes, [
		"Old approval note.\n> ppr",
		"New approval note.\n> ppr",
	]);
});
test("a changed rider needs a fresh disposition; a delegated or pending rider cannot silently become a binding node", () => {
	const x = review();
	x.answer("rider/1/A", "accept");
	x.answer("rider/1/B", "leave_open");
	x.answer("mandate/1", "rework");
	const newRule = { ...rule, label: "B" };
	assert.ok(
		"reject" in
			x.reduce({
				kind: "publish_mandate",
				draft: { ...draft, riders: [], nodes: [rule, newRule] },
				replies: [],
			}),
	);
	x.publish({
		...draft,
		riders: [
			{ ...draft.riders[0]!, text: "Validate every operation." },
			...draft.riders.slice(1),
		],
	});
	assert.ok(x.asks().some((a) => a.subject === "rider/2/A"));
	assert.ok(!x.asks().some((a) => a.subject === "rider/2/B"));
});
test("decline records every numbered annotation as not pursued and withdraws every turn and decision", () => {
	const x = review();
	const annotations = [note(1, "Too much surface."), note(2, "No caller.")];
	const r = x.answer("mandate/1", "decline", annotations);
	assert.equal(r.send?.length ?? 0, 0);
	assert.equal(x.state().phase, "closed");
	assert.deepEqual(x.asks(), []);
	assert.equal(x.input(), "");
	assert.deepEqual(design.effects(x.state(), world), []);
	assert.equal(x.state().mandate, null);
	for (const n of annotations)
		assert.ok(
			r.notes?.some(
				(m) => m.text.includes(n.text) && /not pursued/i.test(m.text),
			),
		);
});
test("a stopped draft resumes with its annotation debt under a new draft token, never as Ground", () => {
	const x = review();
	x.answer("mandate/1", "rework", [note(1, "Clarify callers.")]);
	const t = design.agents(x.state(), world)[0]!.expects[0]!.token;
	const r = x.act({
		kind: "agent_stalled",
		agent: "designer",
		tokens: [t],
		cause: "stopped",
		lastWords: "reading",
	});
	assert.equal(r.send?.[0]?.lane, "queue");
	assert.equal(x.input(), "");
	x.act({
		kind: "resume",
		cause: r.send![0]!.event.cause!,
		direction: "Read ADR 4",
		evidence: "reading",
	});
	const turn = design.agents(x.state(), world)[0]!.expects[0]!;
	assert.deepEqual(turn.tools, ["publish_mandate"]);
	assert.notEqual(t, turn.token);
	for (const v of ["Read ADR 4", "Clarify callers."])
		assert.ok(x.input().includes(v));
});
