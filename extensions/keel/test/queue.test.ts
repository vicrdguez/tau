import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId } from "tau/durable";
import { type WorkId, workId } from "../src/kernel/ids.ts";
import type { LaneEvent, RegisteredLane, World } from "../src/kernel/lane.ts";
import { queueLane, queueTools } from "../src/lanes/queue/index.ts";
import { trunkLane } from "../src/lanes/verify/trunk.ts";

const id = (n: number) => workId(n as ConversationId);
const a = id(1),
	b = id(2),
	c = id(3);
const world: World = {
	work: null,
	root: "/project",
	now: 1,
	options: {
		design: "a/b",
		build: "a/b",
		verify: "a/b",
		queue: "a/b",
		trunk: "trunk",
		base: "main",
		max_workers: 1,
	},
	view: () => null,
};
function project(entry: RegisteredLane) {
	return entry.use((lane) => {
		let state = lane.state.initial();
		return {
			asks: () => lane.asks(state, world),
			send(event: LaneEvent) {
				const result = lane.reduce(state, event, world);
				assert.ok(!("reject" in result), JSON.stringify(result));
				state = result.state;
				return result.send ?? [];
			},
		};
	});
}
const file = (
	work: WorkId,
	lane = "build",
	cause = "stop/1",
	item: string | null = "i1",
) => ({
	kind: "file",
	work,
	lane,
	cause,
	item,
	evidence: `evidence ${work}/${lane}/${cause}`,
});
const answer = (subject: string, choice: string, texts: string[] = []) => ({
	kind: "answered",
	subject,
	choice,
	decision: `${subject}#1`,
	annotations: texts.map((text, i) => ({ n: i + 1, text })),
});
const take = (work: WorkId) => ({ kind: "take_slot", work });
const release = (work: WorkId) => ({ kind: "release_slot", work });
const grant = (work: WorkId) => [
	{ lane: "verify", work, event: { kind: "slot_granted" } },
];

test("one decision per holding cause names its evidence, independent of other works and filers", () => {
	const q = project(queueLane);
	const filings = [file(a), file(a, "verify"), file(b)];
	for (const event of [...filings, filings[0]!]) q.send(event);
	assert.equal(q.asks().length, 3);
	assert.equal(new Set(q.asks().map((ask) => ask.subject)).size, 3);
	for (const { evidence } of filings) {
		const matches = q.asks().filter((ask) => ask.basis.includes(evidence));
		assert.equal(matches.length, 1);
		assert.deepEqual(matches[0]!.choices, ["resume", "cancel"]);
	}
});

test("item resume carries the evidence and direction, resets only that item, and leaves another cause open", () => {
	const q = project(queueLane);
	const first = file(a, "verify", "thread/1");
	q.send(first);
	const subject = q.asks()[0]!.subject;
	q.send(file(a));
	const out = q.send(
		answer(subject, "resume", ["Measure twice.", "Keep the fence."]),
	);
	assert.equal(out.length, 2);
	const resume = out.find((m) => m.event.kind === "resume");
	assert.ok(resume);
	assert.equal(resume.lane, "verify");
	assert.equal(resume.work, a);
	assert.equal(resume.event.cause, first.cause);
	assert.equal(resume.event.item, "i1");
	assert.equal(resume.event.evidence, first.evidence);
	assert.match(
		String(resume.event.direction),
		/Measure twice\.[\s\S]+Keep the fence\./,
	);
	assert.deepEqual(
		out.find((m) => m.event.kind === "reset_counts"),
		{ lane: "verify", work: a, event: { kind: "reset_counts", item: "i1" } },
	);
	assert.equal(q.asks().length, 1);
	assert.ok(q.asks()[0]!.basis.includes(file(a).evidence));
});

test("work-level resume reaches its filer without resetting any item", () => {
	const q = project(queueLane);
	const finding = file(b, "design", "ground/1", null);
	q.send(finding);
	assert.deepEqual(q.send(answer(q.asks()[0]!.subject, "resume")), [
		{
			lane: "design",
			work: b,
			event: {
				kind: "resume",
				cause: finding.cause,
				item: null,
				evidence: finding.evidence,
				direction: "",
			},
		},
	]);
	q.send(finding); // A repeated filing of that situation cannot reopen it.
	assert.deepEqual(q.asks(), []);
});

test("cancel withdraws all questions about one work; a stale answer cannot release a hold or landing slot", () => {
	const q = project(queueLane);
	q.send(file(a));
	const stale = q.asks()[0]!.subject;
	const stoppedAgain = file(a, "build", "stop/2");
	q.send(stoppedAgain);
	q.send(file(b));
	const out = q.send(
		answer(
			q.asks().find((ask) => ask.basis.includes(stoppedAgain.evidence))!
				.subject,
			"cancel",
		),
	);
	assert.deepEqual(
		[...out].sort((x, y) => x.lane.localeCompare(y.lane)),
		["build", "design", "verify"].map((lane) => ({
			lane,
			work: a,
			event: { kind: "cancel" },
		})),
	);
	assert.equal(q.asks().length, 1);
	assert.ok(q.asks()[0]!.basis.includes(file(b).evidence));
	assert.deepEqual(q.send(answer(stale, "resume")), []);
	assert.equal(q.asks().length, 1);
});

test("one project slot grants waiters once in arrival order; another work's stale release cannot unlock it", () => {
	const trunk = project(trunkLane);
	assert.deepEqual(trunk.send(take(a)), grant(a));
	for (const event of [take(b), take(c), take(b), take(a)])
		assert.deepEqual(trunk.send(event), []);
	assert.deepEqual(trunk.send(release(a)), grant(b));
	assert.deepEqual(trunk.send(release(a)), []);
	assert.deepEqual(trunk.send(release(b)), grant(c));
	assert.deepEqual(trunk.send(release(c)), []);
	assert.deepEqual(trunk.send(take(a)), grant(a));
});

test("cancelling a waiting landing drops its request; an active landing keeps its slot until Verify releases it", () => {
	const trunk = project(trunkLane);
	trunk.send(take(a));
	trunk.send(take(b));
	assert.deepEqual(trunk.send(release(b)), []);
	assert.deepEqual(trunk.send(take(c)), []);
	assert.deepEqual(trunk.send(release(a)), grant(c));
	assert.deepEqual(trunk.send(release(c)), []);
});

test("queue and trunk are version-one project records and have no agent tools", () => {
	assert.deepEqual(queueTools, []);
	for (const entry of [queueLane, trunkLane])
		entry.use((lane) => {
			assert.equal(lane.state.version, 1);
			assert.equal(lane.state.kind, `keel.${lane.name}`);
			assert.equal(lane.state.scope, "session");
			const state = lane.state.initial();
			assert.deepEqual(lane.asks(state, world), []);
			assert.deepEqual(lane.agents(state, world), []);
			assert.deepEqual(lane.effects(state, world), []);
		});
});
