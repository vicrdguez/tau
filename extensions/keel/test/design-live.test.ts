import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import { drive } from "./fixtures/drive.ts";

const work = 12 as WorkId;
const world: World = {
	work,
	root: "/project",
	now: 1,
	view: () => null,
	options: {
		design: "a/a",
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

function run() {
	let state = design.state.initial();
	const send = (event: LaneEvent) => drive(design, state, event, world);
	const act = (event: LaneEvent) => {
		const result = send(event);
		assert.ok("state" in result, JSON.stringify(result));
		state = result.state;
		return result;
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
	x.act({ kind: "publish_mandate", draft, replies: [] });
	assert.deepEqual(x.asks()[0]?.choices, ["approve", "rework", "decline"]);
	assert.equal(x.mandate(), null);
});

test("revision review is a delta, and approval binds only on acknowledgement of that exact plan's Mandate", () => {
	const x = pending();
	const old = x.mandate();
	const turn = x.turn();
	assert.deepEqual(turn?.tools, ["publish_revision"]);
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

test("a revision refuses empty, unchanged, malformed, duplicated, or unclassified edits", () => {
	const x = pending();
	for (const changes of [
		{},
		{ nodes: [rule] },
		{ nodes: [{ ...correction, probe: " " }] },
		{ nodes: [correction, correction] },
		{ nodes: [correction, { ...untouched, rule: "Change the timestamp." }] },
		{ checks: [{ ...small.checks[0]!, timeoutMs: 0 }] },
		{ nodes: [{ ...correction, label: "R3" }] },
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
	x.act({ kind: "publish_mandate", draft, replies: [] });
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
	assert.deepEqual(x.turn()?.tools, ["publish_revision"]);
	assert.notEqual(x.turn()?.token, token);
	for (const part of [note.text, "Use the fixture."])
		assert.ok(x.input().includes(part));
	x.act({ ...publish, replies: [reply] });
	const second = x.asks()[0]!;
	assert.notEqual(first, second.subject);
	assert.ok(second.basis.includes(reply.reason));
	assert.deepEqual(x.answer(first, "approve").send ?? [], []);
	assert.equal(x.asks()[0]?.subject, second.subject);
});

test("declining releases only that proposal's causes and the next request waits for durable disposition", () => {
	const x = pending();
	const old = x.mandate();
	x.act(publish);
	const [first] = x.asks();
	const second = {
		...request,
		causes: ["finding-3"],
		text: "A second independent revision.",
	};
	x.act(second);
	x.act(second);
	assert.deepEqual(x.asks(), [first]);
	const declined = x.answer(first!.subject, "decline", [note]);
	assert.deepEqual(declined.send, [
		{
			lane: "queue",
			work: null,
			event: { kind: "revision_declined", work, causes: request.causes },
		},
	]);
	assert.deepEqual(x.mandate(), old);
	assert.ok(x.input().includes(second.text));
	x.act(publish);
	const approved = x.answer(x.asks()[0]!.subject, "approve").send![0]!.event;
	assert.deepEqual(approved.causes, second.causes);
	const third = {
		...request,
		text: "Check other whitespace.",
		causes: ["finding-4"],
	};
	x.act(third);
	assert.equal(x.turn(), undefined);
	x.act({
		kind: "revision_activated",
		causes: second.causes,
	});
	assert.ok(x.input().includes(third.text));
	assert.ok(x.input().includes(correction.rule));
	assert.ok(
		"reject" in x.send(publish),
		"the third proposal drafts against the newly bound Mandate",
	);
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
