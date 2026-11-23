import assert from "node:assert/strict";
import { test } from "node:test";
import { type Draft, draftError } from "../src/lanes/design/draft.ts";
import {
	mandateLabels,
	renderMandate,
	repliesCover,
} from "../src/lanes/design/public.ts";
import {
	reviewChoices,
	reviewDriver,
	synthesis,
} from "./fixtures/design-review.ts";
import { holdingChoice } from "./fixtures/drive.ts";

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
	const x = reviewDriver();
	return {
		...x,
		publish: (d = draft, replies: ReturnType<typeof reply>[] = []) =>
			x.publishMandate({ kind: "publish_mandate", draft: d, replies }),
		attemptDraft: (
			d: typeof draft,
			replies: { n: number; status: string; reason: string }[],
		) =>
			x.attempt({ ...synthesis, kind: "publish_mandate", draft: d, replies }),
	};
}
function review() {
	const x = run();
	x.send(start);
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
		assert.ok("reject" in x.attempt({ ...start, audit: invalid }));
	x.send(start);
	assert.equal(x.turn()?.situation, "shape");
	assert.deepEqual(x.asks(), []);
	for (const value of [
		audit.exists,
		audit.gaps[0]!.text,
		audit.contradictions[0]!.text,
	])
		assert.ok(x.input().includes(value));
});
test("the reviewed draft requires complete rulings, seam contracts, criteria and rider dispositions", () => {
	for (const patch of [
		{ settlements: draft.settlements.slice(1) },
		{ seams: [{ ...seam, callersLater: " " }] },
		{ seams: [{ ...seam, signature: "call this" }] },
		{ seams: [{ ...seam, usage: "plain" }] },
		{ alternatives: " " },
		{ riders: [{ ...draft.riders[0]!, origin: "owner" }] },
		{ riders: [{ ...draft.riders[0]!, disposition: "undecided" }] },
		{ riders: [{ ...draft.riders[0]!, label: "S1" }] },
		{ references: [{ label: "G1", source: "a pattern" }] },
	])
		assert.ok(
			draftError({ ...draft, ...patch } as Draft, audit),
			JSON.stringify(patch),
		);
	const x = run();
	x.send(start);
	x.frame();
	assert.ok(
		"reject" in
			x.attemptDraft(
				{ ...draft, seams: [{ ...seam, signature: "call this" }] },
				[],
			),
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
	const labels = mandateLabels(m);
	const text = renderMandate(m);
	assert.match(text, /Ruling: Add a builder\./);
	assert.match(
		text,
		/## Binding nodes[\s\S]*Validate at close\.[\s\S]*## Delegated riders[\s\S]*Sort imports\.[\s\S]*## Design considerations/,
	);
	const brief = renderMandate(m, ["S1", "A"]);
	assert.ok(brief.includes(seam.usage));
	assert.ok(brief.includes("Validate at close."));
	assert.doesNotMatch(brief, /Sort imports|Explicit builders/);
	for (const l of ["S1", "R1", "A", "C", "G1", "C1", "P1"])
		assert.ok(labels.includes(l));
	for (const l of ["B", "tradeoffs", "alternatives"])
		assert.ok(!labels.includes(l));
	const before = x.state();
	assert.equal(x.answer("mandate/1", "approve").send?.length ?? 0, 0);
	assert.deepEqual(x.state(), before);
});
test("binding an incidental rider does not manufacture an Encode obligation without a seam or rule", () => {
	const x = run();
	x.send({
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
	assert.ok(mandateLabels(m).includes("B"));
	assert.equal(m.encodeRequired, false);
});
test("numbered replies must exactly cover the owner's notes", () => {
	for (const replies of [
		[reply(1)],
		[reply(2), reply(2)],
		[reply(1), reply(2), reply(2)],
		[reply(1), reply(3)],
		[reply(0), reply(2)],
		[reply(1), reply(1.5)],
		[reply(1), { ...reply(2), status: "ignored" }],
		[reply(1), { ...reply(2), reason: " " }],
	])
		assert.equal(
			repliesCover(2, replies as Parameters<typeof repliesCover>[1]),
			false,
		);
});

test("a changed Mandate quotes the original owner passage and refuses old answers; resuming carries only the latest notes", () => {
	const x = review();
	const basis = x.asks()[0]!.basis;
	const passage = `Current callers: ${seam.callersNow}\nFuture callers: ${seam.callersLater}`;
	const start = basis.indexOf(passage);
	assert.ok(start >= 0);
	const range = { start, end: start + passage.length };
	const priorNote = "Also include the CLI.";
	x.answer("mandate/1", "rework", [
		{ n: 1, text: priorNote, range },
		note(2, "Explain the cost."),
	]);
	assert.match(x.input(), /Also include the CLI/);
	assert.ok("reject" in x.attemptDraft(draft, [reply(1)]));
	x.publish({ ...draft, never: "No duplicate parser." }, [reply(2), reply(1)]);
	const current = x.asks()[0]!;
	assert.deepEqual(x.state().rounds[0]?.answer?.annotations[0]?.range, range);
	assert.ok(
		current.basis.includes(
			`> Current callers: ${seam.callersNow}\n> Future callers: ${seam.callersLater}`,
		),
	);
	assert.ok(current.basis.includes(reply(1).reason));
	assert.ok(!current.basis.includes(`[${range.start}:${range.end}]`));
	x.answer("mandate/1", "approve");
	assert.equal(x.state().mandate, null);
	assert.equal(x.asks()[0]?.subject, current.subject);

	x.answer(current.subject, "rework", [note(1, "Clarify API callers.")]);
	const t = x.turn()!.token;
	x.send({
		kind: "agent_stalled",
		agent: "designer",
		token: t,
		cause: "stopped",
		lastWords: "reading",
	});
	assert.equal(x.input(), "");
	x.send(holdingChoice(x.asks()[0]!, "resume", "Read ADR 4"));
	assert.deepEqual(x.turn()?.tools, ["publish_mandate", "start_experiment"]);
	for (const value of [
		"No duplicate parser.",
		"Clarify API callers.",
		"Read ADR 4",
	])
		assert.ok(x.input().includes(value), value);
	assert.doesNotMatch(
		x.input(),
		/Also include the CLI|See the revised ruling|Replies to the preceding round|Approve the Mandate/,
	);
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
		checks: [{ ...draft.checks[0]!, timeoutMs: 120 }],
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
			{ label: "intent", source: "Revised intent ADR" },
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
		"intent changed",
		"P1 changed",
		"R2 new",
		"rider B changed",
		"rider D new",
		"R1 removed",
		"rider C removed",
	])
		assert.ok(lead.includes(change), change);
	assert.doesNotMatch(lead, /rider A (new|changed|removed)/i);
	assert.match(current!, /S1: Seam \(changed\)\n\nChanged: owner\n/i);
	assert.match(
		current!,
		/P1: Proof \(changed\)\n\nChanged: timeout, reference\n/i,
	);
	assert.match(current!, /B: Rider \(changed\)\n\nChanged: disposition\n/i);
	assert.match(current!, /R2: Rule \(new\)[\s\S]*Reference: Construction ADR/i);
	assert.match(current!, /B: Rider \(changed\)[\s\S]*Disposition: bind/i);
	assert.match(current!, /D: Rider \(new\)[\s\S]*Disposition: open/i);
	const entries = current!.split(/^### /m);
	assert.match(
		entries.find((s) => s.startsWith("B: Rider"))!,
		/Disposition: bind[\s\S]*Previously[\s\S]*Sort imports\.[\s\S]*Disposition: open/,
	);
	assert.match(
		entries.find((s) => s.startsWith("P1: Proof"))!,
		/Timeout: 120 ms[\s\S]*Previously[\s\S]*\["check","same IR"\][\s\S]*Timeout: 90 ms[\s\S]*Reference: Proof ADR/,
	);
	assert.doesNotMatch(current!, /^### (?:A: Rider \(|R1:|C: Rider\b)/im);
	assert.match(
		removed!,
		/R1: Rule[\s\S]*One representation\.[\s\S]*Count the encodings\./,
	);
	assert.match(removed!, /C: Rider[\s\S]*Seal regions\./);
	assert.equal(x.state().mandate, null);
	x.answer("mandate/2", "approve");
	assert.ok(mandateLabels(x.state().mandate!).includes("R2"));
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
	assert.deepEqual(x.effects(), []);
	assert.equal(x.state().mandate, null);
	assert.doesNotMatch(r.notes?.[0]?.text ?? "", /Already addressed/);
	for (const n of annotations)
		assert.ok(
			r.notes?.some(
				(m) => m.text.includes(n.text) && /not pursued/i.test(m.text),
			),
		);
});
