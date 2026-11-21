import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import * as mandate from "../src/lanes/design/public.ts";
import {
	challengeReview,
	crossFamilyOptions,
	frameReview,
	reviewChoices,
	synthesis,
} from "./fixtures/design-review.ts";
import { drive } from "./fixtures/drive.ts";

const world: World = {
	work: 12 as WorkId,
	root: "/repo",
	now: 1,
	view: () => null,
	options: {
		design: "x/x",
		...crossFamilyOptions,
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
	riders: [
		{
			label: "A",
			text: "Validate at close.",
			origin: "evidence",
			disposition: "bind",
		},
		{
			label: "B",
			text: "Sort imports.",
			origin: "incidental",
			disposition: "open",
		},
		{
			label: "C",
			text: "Seal regions.",
			origin: "seeded",
			disposition: "bind",
		},
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
	const reduce = (event: LaneEvent) =>
		drive(
			design,
			state,
			event.kind === "publish_mandate" ? { ...synthesis, ...event } : event,
			world,
		);
	const act = (event: LaneEvent) => {
		const result = reduce(event);
		assert.ok("state" in result, JSON.stringify(result));
		state = result.state;
		return result;
	};
	const driver = { act, state: () => state };
	const frame = () => frameReview(driver, world);
	const publish = (d = draft, replies: ReturnType<typeof reply>[] = []) => {
		act({ kind: "publish_mandate", draft: d, replies });
		challengeReview(driver, world);
	};
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
	return { ...driver, reduce, frame, publish, answer, asks, input };
}
function review() {
	const x = run();
	x.act(start);
	x.frame();
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
test("a draft needs every Ground ruling, unique labels, callers, fenced code, probes, proof, alternatives and rider dispositions", () => {
	const x = run();
	x.act(start);
	x.frame();
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
		{ riders: [{ ...draft.riders[0], disposition: "undecided" }] },
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
test("one annotatable Mandate names the goal and reviews all nodes and rider dispositions on one decision", () => {
	const x = review();
	assert.equal(x.asks().length, 1);
	const [main] = x.asks();
	assert.ok(main!.title.includes(draft.intent));
	assert.deepEqual(main!.choices, reviewChoices);
	const basis = main!.basis;
	assert.match(basis, /approv\w*[^\n]*nodes[^\n]*even[^\n]*reference/i);
	assert.match(basis, /^### P1: Proof$/im);
	assert.match(
		basis,
		/## Riders[\s\S]*A: Rider[\s\S]*Origin: evidence[\s\S]*Disposition: bind/,
	);
	assert.match(
		basis,
		/B: Rider[\s\S]*Origin: incidental[\s\S]*Disposition: open/,
	);
	assert.doesNotMatch(
		basis,
		/\(new\)|previous round|last round|preceding round/i,
	);
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
		"Proof ADR",
		...draft.riders.map((r) => r.text),
	])
		assert.ok(basis.includes(value), value);
	assert.ok(basis.indexOf(seam.usage) < basis.indexOf(seam.signature));
});
test("approving binds riders proposed to bind, delegates open riders and preserves anchored notes exactly once", () => {
	const x = review();
	const anchor = x.asks()[0]!.basis.indexOf(rule.probe);
	const approved = x.answer("mandate/1", "approve", [
		{
			n: 1,
			text: "Use exact counts.",
			range: { start: anchor, end: anchor + rule.probe.length },
		},
	]);
	assert.equal(approved.send?.length, 1);
	assert.deepEqual(x.asks(), []);
	const m = x.state().mandate!;
	assert.deepEqual(approved.send?.[0]?.event.mandate, m);
	assert.equal(m.encodeRequired, true);
	assert.deepEqual(m.approvalNotes, [`Use exact counts.\n> ${rule.probe}`]);
	assert.deepEqual(m.delegated, [
		{ label: "B", text: "Sort imports.", origin: "incidental" },
	]);
	assert.deepEqual(
		m.nodes.find((n) => n.label === "R1"),
		rule,
	);
	const s = m.nodes.find((n) => n.label === "S1");
	assert.ok(
		s && "section" in s && s.section === "Seam" && s.body.includes(seam.usage),
	);
	const labels = mandate.mandateLabels(m);
	for (const l of ["S1", "R1", "A", "C", "G1", "C1", "P1"])
		assert.ok(labels.includes(l));
	for (const l of ["B", "tradeoffs", "alternatives"])
		assert.ok(!labels.includes(l));
	const before = x.state();
	assert.equal(x.answer("mandate/1", "approve").send?.length ?? 0, 0);
	assert.deepEqual(x.state(), before);
});
test("the bound Mandate is a document with settled rulings, readable code and nonbinding design context", () => {
	const x = review();
	x.answer("mandate/1", "approve");
	const m = x.state().mandate!;
	assert.ok(
		"renderMandate" in mandate && typeof mandate.renderMandate === "function",
		"Design must expose a readable bound Mandate renderer",
	);
	const text = mandate.renderMandate(m);
	assert.match(text, /Ruling: Add a builder\./);
	assert.doesNotMatch(text, /Proposed|Owner-reviewed/);
	assert.ok(text.includes(seam.usage));
	assert.ok(text.includes(seam.signature));
	assert.ok(text.includes('["check","same IR"]'));
	assert.match(
		text,
		/## Binding nodes[\s\S]*Validate at close\.[\s\S]*## Delegated riders[\s\S]*Sort imports\.[\s\S]*## Design considerations/,
	);
	assert.ok(
		text.indexOf(draft.tradeoffs) > text.indexOf("## Design considerations"),
	);
	assert.ok(
		text.indexOf(draft.alternatives) > text.indexOf("## Design considerations"),
	);
	const brief = mandate.renderMandate(m, ["S1", "A"]);
	assert.ok(brief.includes(seam.usage));
	assert.ok(brief.includes("Validate at close."));
	assert.ok(!brief.includes("Sort imports."));
	assert.ok(!brief.includes(draft.tradeoffs));
});
test("binding an incidental rider does not manufacture an Encode obligation without a seam or rule", () => {
	const x = run();
	x.act({
		...start,
		audit: { exists: "Reports use plain text.", gaps: [], contradictions: [] },
	});
	x.frame();
	x.publish({
		...draft,
		seams: [],
		nodes: [],
		settlements: [],
		riders: [{ ...draft.riders[1]!, disposition: "bind" }],
	});
	x.answer("mandate/1", "approve");
	const m = x.state().mandate!;
	assert.ok(mandate.mandateLabels(m).includes("B"));
	assert.equal(m.encodeRequired, false);
});
test("rework preserves ranges and refuses missing, duplicate, extra, invalid or empty replies; an old round's answer is stale", () => {
	const x = review();
	const annotations = [note(1, "Prefer native."), note(2, "Explain the cost.")];
	x.answer("mandate/1", "rework", annotations);
	assert.deepEqual(x.asks(), []);
	for (const n of annotations) assert.ok(x.input().includes(n.text));
	assert.doesNotMatch(x.input(), /Approve the Mandate|Annotate this document/i);
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
	assert.deepEqual(
		x.state().rounds[0]!.answer?.annotations.map(({ n, text, range }) => ({
			n,
			text,
			range,
		})),
		annotations,
	);
	assert.deepEqual(x.state().rounds[0]!.draft, draft);
	const basis = x.asks()[0]!.basis;
	for (const n of annotations) assert.ok(basis.includes(n.text));
	assert.ok(basis.includes(reply(1).reason));
	assert.match(basis, /1\. Prefer native\.\n> /);
	assert.doesNotMatch(basis, /\[1:4\]|\[2:5\]/);
	const before = x.state();
	x.answer("mandate/1", "approve");
	assert.deepEqual(x.state(), before);
});
test("a revision marks changed and new nodes and riders, and shows removed content separately", () => {
	const x = review();
	x.answer("mandate/1", "rework");
	x.publish({
		...draft,
		seams: [{ ...seam, owner: "Native IR" }],
		nodes: [
			{
				label: "R2",
				rule: "Explicit construction.",
				probe: "Count constructors.",
			},
		],
		riders: [
			draft.riders[0]!,
			{ ...draft.riders[1]!, disposition: "bind" },
			{
				label: "D",
				text: "Use builders.",
				disposition: "open",
				origin: "evidence",
			},
		],
		references: [
			{ label: "P1", source: "Revised proof ADR" },
			{ label: "R2", source: "Construction ADR" },
		],
	});
	const [ask] = x.asks();
	assert.equal(ask!.subject, "mandate/2");
	const [current, removed] = ask!.basis.split(
		"## Removed since the last round",
	);
	const lead = current!.split("###", 1)[0]!;
	assert.match(lead, /Since round 1:[^\n]*S1 changed/i);
	for (const change of [
		"P1 changed",
		"R2 new",
		"rider B changed",
		"rider D new",
		"R1 removed",
		"rider C removed",
	])
		assert.ok(lead.includes(change), change);
	assert.doesNotMatch(lead, /rider A (new|changed|removed)/i);
	assert.match(current!, /S1: Seam \(changed\)/i);
	assert.match(current!, /P1: Proof \(changed\)/i);
	assert.match(current!, /R2: Rule \(new\)[\s\S]*Reference: Construction ADR/i);
	assert.match(current!, /B: Rider \(changed\)[\s\S]*Disposition: bind/i);
	assert.match(current!, /D: Rider \(new\)[\s\S]*Disposition: open/i);
	assert.doesNotMatch(current!, /^### (?:A: Rider \(|R1:|C: Rider\b)/im);
	assert.match(
		removed!,
		/R1: Rule[\s\S]*One representation\.[\s\S]*Count the encodings\./,
	);
	assert.match(removed!, /C: Rider[\s\S]*Seal regions\./);
	assert.equal(x.state().mandate, null);
	x.answer("mandate/2", "approve");
	assert.ok(mandate.mandateLabels(x.state().mandate!).includes("R2"));
});
test("a changed rider and proof include their complete previous content", () => {
	const x = review();
	x.answer("mandate/1", "rework");
	x.publish({
		...draft,
		riders: draft.riders.map((r) =>
			r.label === "B" ? { ...r, disposition: "bind" } : r,
		),
		checks: [{ ...draft.checks[0]!, timeoutMs: 120 }],
	});
	const entries = x.asks()[0]!.basis.split(/^### /m);
	const rider = entries.find((s) => s.startsWith("B: Rider"))!;
	const proof = entries.find((s) => s.startsWith("P1: Proof"))!;
	assert.match(
		rider,
		/Disposition: bind[\s\S]*^#### Previously$[\s\S]*Sort imports\.[\s\S]*Origin: incidental[\s\S]*Disposition: open/m,
	);
	assert.match(
		proof,
		/Timeout: 120 ms[\s\S]*^#### Previously$[\s\S]*\["check","same IR"\][\s\S]*Timeout: 90 ms[\s\S]*Reference: Proof ADR/m,
	);
});

test("the reply quotes the exact multiline owner passage and keeps only stored offsets", () => {
	const x = review();
	const basis = x.asks()[0]!.basis;
	const passage = `Current callers: ${seam.callersNow}\nFuture callers: ${seam.callersLater}`;
	const start = basis.indexOf(passage);
	assert.ok(start >= 0);
	const range = { start, end: start + passage.length };
	x.answer("mandate/1", "rework", [
		{ n: 1, text: "Also include the CLI.", range },
	]);
	x.publish(draft, [reply(1)]);
	assert.deepEqual(x.state().rounds[0]?.answer?.annotations[0]?.range, range);
	const rendered = x.asks()[0]!.basis;
	assert.ok(
		rendered.includes(
			`> Current callers: ${seam.callersNow}\n> Future callers: ${seam.callersLater}`,
		),
	);
	assert.ok(!rendered.includes(`[${range.start}:${range.end}]`));
});

test("revision input includes the current draft and owed annotations but not earlier replies", () => {
	const x = review();
	x.answer("mandate/1", "rework", [note(1, "Earlier resolved question.")]);
	x.publish({ ...draft, never: "No duplicate parser." }, [
		{ ...reply(1), reason: "Explanation already delivered." },
	]);
	x.answer("mandate/2", "rework", [note(1, "Tell me about the API now.")]);
	const input = x.input();
	assert.match(input, /No duplicate parser\./);
	assert.match(input, /Tell me about the API now\./);
	assert.doesNotMatch(
		input,
		/Earlier resolved question|Explanation already delivered|Replies to the preceding round/,
	);
});

test("decline records every still-owed annotation, not already answered notes, and withdraws all work", () => {
	const x = review();
	x.answer("mandate/1", "rework", [note(1, "Already addressed.")]);
	x.publish(draft, [reply(1)]);
	const annotations = [note(1, "Too much surface."), note(2, "No caller.")];
	const r = x.answer("mandate/2", "decline", annotations);
	assert.equal(r.send?.length ?? 0, 0);
	assert.equal(x.state().phase, "closed");
	assert.deepEqual(x.asks(), []);
	assert.equal(x.input(), "");
	assert.deepEqual(design.effects(x.state(), world), []);
	assert.equal(x.state().mandate, null);
	assert.doesNotMatch(r.notes?.[0]?.text ?? "", /Already addressed/);
	for (const n of annotations)
		assert.ok(
			r.notes?.some(
				(m) => m.text.includes(n.text) && /not pursued/i.test(m.text),
			),
		);
});
test("decline writes still-owed approval notes from earlier rounds, with each round identified", () => {
	const x = review();
	x.answer("mandate/1", "rework");
	x.publish();
	// An earlier approving answer exists in saved history but was not handed to Build.
	const prior = x.state().rounds[0]!.answer!;
	prior.choice = "approve";
	prior.annotations = [
		{ n: 1, text: "Older approval note.", range: null, excerpt: null },
	];
	const r = x.answer("mandate/2", "decline", [note(1, "New reason.")]);
	assert.match(
		r.notes?.[0]?.text ?? "",
		/Round 1[\s\S]*1\. Older approval note\.[^\n]*not pursued/i,
	);
	assert.match(
		r.notes?.[0]?.text ?? "",
		/Round 2[\s\S]*1\. New reason\.[^\n]*not pursued/i,
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
