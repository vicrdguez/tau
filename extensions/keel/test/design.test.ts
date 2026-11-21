import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import { drive } from "./fixtures/drive.ts";

const work = 17 as WorkId;
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
		max_workers: 3,
		base: "main",
		trunk: "trunk",
	},
};
const mandate = {
	intent: "Reject orders below the minimum.",
	nodes: [
		{
			label: "R1",
			rule: "The boundary is inclusive.",
			probe: "One less than the minimum fails.",
		},
	],
	checks: [{ id: "P1", argv: ["env", "test"], timeoutMs: 5000 }],
};
const bound = {
	kind: "ground",
	route: "follow",
	reference: "Orders ADR 3",
	mandate,
};
const ambiguous = {
	kind: "ground",
	route: "ambiguous",
	reference: "The minimum lot size differs by venue.",
	readings: ["Use the venue minimum.", "Use the exchange minimum."],
};
function advance(event: LaneEvent, state = design.state.initial()) {
	const result = drive(design, state, event, world);
	assert.ok(!("reject" in result), JSON.stringify(result));
	return result;
}

test("a precedent-following Mandate binds once under the prompt without an owner ask", () => {
	const { state, send } = advance(bound);
	assert.deepEqual(send, [
		{
			lane: "build",
			work,
			event: {
				kind: "bound",
				mandate: {
					...mandate,
					considerations: null,
					delegated: [],
					encodeRequired: false,
					approvalNotes: [],
				},
			},
		},
	]);
	assert.deepEqual(design.asks(state, world), []);
	assert.equal(state.reference, bound.reference);
	assert.deepEqual(state.mandate, {
		...mandate,
		considerations: null,
		delegated: [],
		encodeRequired: false,
		approvalNotes: [],
	});
	assert.deepEqual(
		design.agents(state, world).map((a) => [a.key, a.role, a.expects]),
		[["designer", "designer", []]],
	);
	assert.ok("reject" in design.reduce(state, bound, world));
});
test("Ground refuses missing authority, colliding labels, empty probes and unusable proofs before adoption", () => {
	for (const e of [
		{ ...bound, reference: " " },
		{
			...bound,
			mandate: { ...mandate, nodes: [{ ...mandate.nodes[0]!, label: "P1" }] },
		},
		{
			...bound,
			mandate: {
				...mandate,
				nodes: [{ ...mandate.nodes[0]!, label: "intent" }],
			},
		},
		{
			...bound,
			mandate: { ...mandate, nodes: [{ ...mandate.nodes[0]!, probe: " " }] },
		},
		{ ...bound, mandate: { ...mandate, checks: [] } },
		{
			...bound,
			mandate: { ...mandate, checks: [{ id: "P1", argv: [], timeoutMs: 1 }] },
		},
		{
			...bound,
			mandate: {
				...mandate,
				checks: [{ id: "P1", argv: ["test"], timeoutMs: 0 }],
			},
		},
	])
		assert.ok(
			"reject" in design.reduce(design.state.initial(), e, world),
			JSON.stringify(e),
		);
});
test("an ambiguity needs distinct readings; the current answer supplies the reading and annotations to Ground", () => {
	assert.ok(
		"reject" in
			design.reduce(
				design.state.initial(),
				{ ...ambiguous, readings: ["one", "one"] },
				world,
			),
	);
	const { state, send } = advance(ambiguous);
	assert.deepEqual(send ?? [], []);
	const [ask] = design.asks(state, world);
	assert.ok(ask);
	assert.ok(ask.title.includes(ambiguous.reference));
	for (const reading of ambiguous.readings)
		assert.ok(ask.basis.includes(reading));
	const answer = {
		kind: "answered",
		subject: ask.subject,
		choice: "second",
		annotations: [{ n: 1, text: "Include auctions." }],
	};
	const directed = advance(answer, state).state;
	const input = design.agents(directed, world)[0]?.expects[0]?.input?.() ?? "";
	assert.ok(input.includes(ambiguous.readings[1]!));
	assert.ok(input.includes("Include auctions."));
	assert.deepEqual(design.asks(directed, world), []);
	assert.deepEqual(advance(answer, directed), { state: directed });
	assert.equal(advance(bound, directed).state.mandate?.intent, mandate.intent);
});
test("declining an ambiguity closes the ask without a build", () => {
	const state = advance(ambiguous).state;
	const result = advance(
		{
			kind: "answered",
			subject: design.asks(state, world)[0]!.subject,
			choice: "decline",
			annotations: [],
		},
		state,
	);
	assert.deepEqual(result.send ?? [], []);
	assert.deepEqual(design.asks(result.state, world), []);
	assertDesk(result.state);
});
test("a stopped Ground turn files a hold; resume carries the finding and direction under a new token; cancel closes the turn without retiring the desk", () => {
	const state = advance(ambiguous).state;
	const active = advance(
		{
			kind: "answered",
			subject: design.asks(state, world)[0]!.subject,
			choice: "first",
			annotations: [],
		},
		state,
	).state;
	const turn = design.agents(active, world)[0]!.expects[0]!;
	const stopped = advance(
		{
			kind: "agent_stalled",
			agent: "designer",
			cause: "stopped",
			tokens: [turn.token],
			lastWords: "Still reading.",
		},
		active,
	);
	const [file] = stopped.send ?? [];
	assert.equal(file?.lane, "queue");
	assert.equal(file?.work, null);
	assert.match(String(file?.event.evidence), /Still reading/);
	assertDesk(stopped.state);
	assert.deepEqual(
		advance(
			{
				kind: "agent_stalled",
				agent: "designer",
				tokens: [turn.token],
				cause: "stopped",
				lastWords: "again",
			},
			stopped.state,
		).send ?? [],
		[],
	);
	const resumed = advance(
		{
			kind: "resume",
			cause: file!.event.cause!,
			item: null,
			evidence: file!.event.evidence!,
			direction: "Check venue A.",
		},
		stopped.state,
	);
	const next = design.agents(resumed.state, world)[0]!.expects[0]!;
	assert.notEqual(next.token, turn.token);
	assert.match(next.input?.() ?? "", /Check venue A/);
	assert.match(next.input?.() ?? "", /Still reading/);
	assert.deepEqual(
		advance(
			{
				kind: "agent_stalled",
				agent: "designer",
				tokens: [turn.token],
				cause: "stopped",
				lastWords: "late",
			},
			resumed.state,
		).state,
		resumed.state,
	);
	assertDesk(advance({ kind: "cancel" }, resumed.state).state);
});
function assertDesk(state: ReturnType<typeof design.state.initial>) {
	assert.deepEqual(
		design.agents(state, world).map((a) => [a.key, a.paused, a.expects]),
		[["designer", false, []]],
	);
}

test("a standing desk request asks once without cancelling; only a current confirmation cancels", () => {
	const boundState = advance(bound).state;
	const requested = advance({ kind: "request_cancel" }, boundState);
	assert.equal(requested.state.phase, "bound");
	assert.deepEqual(requested.send ?? [], []);
	const [ask] = design.asks(requested.state, world);
	assert.ok(ask);
	assert.ok(ask.title.includes(mandate.intent));
	assert.ok(ask.basis.includes(mandate.intent));
	assert.match(ask.title, /\?$/);
	assert.doesNotMatch(ask.title, /[.!?]\?$/);
	assert.deepEqual(ask.choices, ["cancel", "continue"]);
	assert.deepEqual(
		design.asks(
			advance({ kind: "request_cancel" }, requested.state).state,
			world,
		),
		[ask],
	);
	const answer = {
		kind: "answered",
		subject: ask.subject,
		choice: "continue",
		annotations: [],
	};
	const kept = advance(answer, requested.state);
	assert.equal(kept.state.phase, "bound");
	assert.deepEqual(design.asks(kept.state, world), []);
	assert.deepEqual(
		advance({ ...answer, choice: "cancel" }, kept.state).send ?? [],
		[],
	);
	assert.deepEqual(
		advance({ ...answer, choice: "cancel" }, requested.state).send,
		[{ lane: "queue", work: null, event: { kind: "cancel_work", work } }],
	);
	for (const kind of ["closed", "cancel"]) {
		const terminal = advance({ kind }, requested.state).state;
		assertDesk(terminal);
		assert.deepEqual(design.asks(terminal, world), []);
		assert.ok(
			"reject" in design.reduce(terminal, { kind: "request_cancel" }, world),
		);
	}
});

test("cancel collects worker and verification cleanup exactly once in the work's final note", () => {
	const state = advance({ kind: "cancel" }, advance(bound).state).state;
	const report = {
		kind: "cleanup_finished",
		lane: "verify",
		kept: ["/integration: registration occupied"],
	};
	const first = advance(report, state);
	assert.deepEqual(first.notes ?? [], []);
	const duplicate = advance(report, first.state);
	assert.deepEqual(duplicate.notes ?? [], []);
	const second = advance(
		{ kind: "cleanup_finished", lane: "build", kept: ["/worker: local draft"] },
		duplicate.state,
	);
	assert.equal(second.notes?.length, 1);
	const text = second.notes[0]!.text;
	assert.match(text, /kept[^\n]*:\s*\/worker/i);
	for (const part of [
		mandate.intent,
		"/integration: registration occupied",
		"/worker: local draft",
	])
		assert.ok(text.includes(part));
	assert.deepEqual(advance(report, second.state).notes ?? [], []);
});

test("Design keeps its version-one identity and unadopted initial state", () => {
	assert.equal(design.state.version, 1);
	assert.equal(design.state.kind, "keel.design");
	assert.equal(design.state.scope, "conversation");
	assert.deepEqual(design.state.initial(), {
		phase: "entry",
		audit: null,
		seed: null,
		rounds: [],
		revisions: [],
		reference: "",
		mandate: null,
		readings: [],
		direction: "",
		cancelRequested: false,
		cleanup: null,
		cause: null,
		seq: 0,
	});
});
