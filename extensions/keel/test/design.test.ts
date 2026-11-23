import assert from "node:assert/strict";
import { test } from "node:test";
import { design } from "../src/lanes/design/index.ts";
import { holdingChoice, laneDriver, laneWorld } from "./fixtures/drive.ts";

const world = laneWorld();
const run = () => laneDriver(design, world);
const mandate = {
	intent: "Reject orders below the minimum.",
	nodes: [
		{
			label: "R1",
			rule: "The boundary is inclusive.",
			probe: "One less fails.",
		},
	],
	checks: [{ id: "P1", argv: ["env", "test"], timeoutMs: 5000 }],
};
const follow = {
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
const answer = (
	subject: string,
	choice: string,
	annotations: { n: number; text: string }[] = [],
) => ({ kind: "answered", subject, choice, annotations });

test("following precedent binds once without asking the owner", () => {
	const x = run();
	const { send } = x.send(follow);
	assert.deepEqual(send, [
		{
			lane: "build",
			work: world.work,
			event: {
				kind: "bound",
				mandate: {
					...mandate,
					encodeRequired: false,
					considerations: null,
					delegated: [],
					approvalNotes: [],
				},
			},
		},
	]);
	assert.deepEqual(x.asks(), []);
	assert.equal(x.state().reference, follow.reference);
	assert.ok("reject" in x.attempt(follow));
});

test("follow refuses missing authority, colliding labels, a rule without a probe, or no usable proof", () => {
	const x = run();
	for (const event of [
		{ ...follow, reference: " " },
		{
			...follow,
			mandate: { ...mandate, nodes: [{ ...mandate.nodes[0]!, label: "P1" }] },
		},
		{
			...follow,
			mandate: {
				...mandate,
				nodes: [{ ...mandate.nodes[0]!, label: "intent" }],
			},
		},
		{
			...follow,
			mandate: { ...mandate, nodes: [{ ...mandate.nodes[0]!, probe: " " }] },
		},
		{ ...follow, mandate: { ...mandate, checks: [] } },
		...[
			{ id: "P1", argv: [], timeoutMs: 1 },
			{ id: "P1", argv: ["test"], timeoutMs: 0 },
		].map((check) => ({ ...follow, mandate: { ...mandate, checks: [check] } })),
	])
		assert.ok("reject" in x.attempt(event), JSON.stringify(event));
});

test("Ground presents two readings; the owner can send one back with direction or decline without binding", () => {
	for (const choice of ["second", "decline"]) {
		const x = run();
		assert.ok(
			"reject" in x.attempt({ ...ambiguous, readings: ["one", "one"] }),
		);
		assert.deepEqual(x.send(ambiguous).send ?? [], []);
		const [ask] = x.asks();
		assert.ok(ask);
		for (const reading of ambiguous.readings)
			assert.ok(ask.basis.includes(reading));
		const event = answer(ask.subject, choice, [
			{ n: 1, text: "Include auctions." },
		]);
		const { send } = x.send(event);
		assert.deepEqual(x.asks(), []);
		if (choice === "decline") {
			assert.deepEqual(send ?? [], []);
			assert.equal(x.agents()[0]?.expect, null);
		} else {
			const input = x.agents()[0]?.expect?.input?.() ?? "";
			assert.match(input, /Use the exchange minimum/);
			assert.match(input, /Include auctions/);
			const directed = x.state();
			x.send(event);
			assert.deepEqual(x.state(), directed);
			assert.equal(x.send(follow).send?.[0]?.event.kind, "bound");
		}
	}
});

test("a stopped Ground turn files a hold; resume carries direction and ignores the old stall", () => {
	const x = run();
	x.send(ambiguous);
	x.send(answer(x.asks()[0]!.subject, "first"));
	const { token } = x.agents()[0]!.expect!;
	const stall = {
		kind: "agent_stalled",
		agent: "designer",
		cause: "stopped",
		token,
		lastWords: "Still reading.",
	};
	x.send(stall);
	assert.match(x.asks()[0]!.basis, /design reports:\nstopped: Still reading/);
	assert.equal(x.agents()[0]?.expect, null);
	x.send(stall);
	assert.equal(x.asks().length, 1);
	x.send(holdingChoice(x.asks()[0]!, "resume", "Check venue A."));
	const next = x.agents()[0]!.expect!;
	assert.notEqual(next.token, token);
	assert.match(next.input?.() ?? "", /Still reading[\s\S]*Check venue A/);
	assert.deepEqual(x.send(stall).send ?? [], []);
});

test("the desk requests one confirmation, keeps working on continue, and cancels only on a current answer", () => {
	const x = run();
	x.send(follow);
	const request = { kind: "request_cancel" };
	assert.deepEqual(x.send(request).send ?? [], []);
	const [ask] = x.asks();
	assert.ok(ask);
	assert.match(ask.basis, /Reject orders below the minimum/);
	assert.deepEqual(ask.choices, ["cancel", "continue"]);
	x.send(request);
	assert.deepEqual(x.asks(), [ask]);
	assert.deepEqual(x.send(answer(ask.subject, "continue")).send ?? [], []);
	assert.equal(x.state().phase, "bound");
	assert.deepEqual(x.asks(), []);
	assert.deepEqual(x.send(answer(ask.subject, "cancel")).send ?? [], []);
	x.send(request);
	assert.deepEqual(x.send(answer(ask.subject, "cancel")).send, [
		{
			lane: "queue",
			work: null,
			event: { kind: "cancel_work", work: world.work },
		},
	]);
	for (const kind of ["closed", "cancel"]) {
		const terminal = run();
		terminal.send(follow);
		terminal.send(request);
		terminal.send({ kind });
		assert.deepEqual(terminal.asks(), []);
		assert.ok("reject" in terminal.attempt(request));
	}
});

test("cancellation reports retained changes once, after both lanes have cleaned up", () => {
	const x = run();
	x.send(follow);
	x.send({ kind: "cancel" });
	const report = (lane: string, kept: string) =>
		x.send({ kind: "cleanup_finished", lane, kept: [kept] }).notes ?? [];
	const worker = "/worker: local draft";
	const integration = "/integration: registration occupied";
	assert.deepEqual(report("build", worker), []);
	assert.deepEqual(report("build", worker), []);
	const notes = report("verify", integration);
	assert.equal(notes.length, 1);
	for (const part of [mandate.intent, worker, integration])
		assert.ok(notes[0]!.text.includes(part));
	assert.deepEqual(report("build", worker), []);
});
