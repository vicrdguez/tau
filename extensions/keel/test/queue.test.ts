import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId } from "tau/durable";
import { type WorkId, workId } from "../src/kernel/ids.ts";
import type { LaneEvent, RegisteredLane } from "../src/kernel/lane.ts";
import { queueLane } from "../src/lanes/queue/index.ts";
import { trunkLane } from "../src/lanes/verify/trunk.ts";
import { laneDriver, laneWorld } from "./fixtures/drive.ts";

const id = (n: number) => workId(n as ConversationId);
const a = id(1),
	b = id(2),
	c = id(3);
const world = laneWorld({ work: null });
function project(entry: RegisteredLane) {
	return entry.use((lane) => {
		const driver = laneDriver(lane, world);
		return {
			asks: driver.asks,
			send: (event: LaneEvent) => driver.send(event).send ?? [],
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
	goal: `Correct the limit for market ${work}`,
	resume: `Replay the same pinned operation after restoring the expected head.`,
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
	for (const { evidence, goal, resume } of filings) {
		const matches = q.asks().filter((ask) => ask.basis.includes(evidence));
		assert.equal(matches.length, 1);
		assert.ok(matches[0]!.title.includes(goal));
		assert.ok(matches[0]!.basis.includes(resume));
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
	assert.equal(out.length, 3);
	assert.deepEqual(
		out.find((m) => m.event.kind === "finding_direction"),
		{
			lane: "verify",
			work: a,
			event: {
				kind: "finding_direction",
				lane: "verify",
				item: "i1",
				cause: first.cause,
				evidence: first.evidence,
				direction: "1. Measure twice.\n2. Keep the fence.",
			},
		},
	);
	const resume = out.find((m) => m.event.kind === "resume");
	assert.deepEqual(resume, {
		lane: "verify",
		work: a,
		event: {
			kind: "resume",
			cause: first.cause,
			item: "i1",
			evidence: first.evidence,
			direction: "1. Measure twice.\n2. Keep the fence.",
		},
	});
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

test("both cancellation routes withdraw only that work's questions and invalidate its answers", () => {
	for (const viaHolding of [true, false]) {
		const q = project(queueLane);
		q.send(file(a));
		const stale = q.asks()[0]!.subject;
		q.send(file(a, "build", "stop/2"));
		q.send(file(b));
		const out = q.send(
			viaHolding
				? answer(q.asks()[1]!.subject, "cancel")
				: { kind: "cancel_work", work: a },
		);
		assert.deepEqual(
			[...out].sort((x, y) => x.lane.localeCompare(y.lane)),
			["build", "design", "verify"].map((lane) => ({
				lane,
				work: a,
				event: { kind: "cancel" },
			})),
		);
		assert.deepEqual(q.send(answer(stale, "resume")), []);
		assert.equal(q.asks().length, 1);
		assert.ok(q.asks()[0]!.basis.includes(file(b).evidence));
	}
});

test("resolving a superseded holding closes only that cause and never resumes its filer", () => {
	const q = project(queueLane);
	const old = file(a, "verify", "thread/1");
	q.send(old);
	const stale = q.asks()[0]!.subject;
	const other = file(a, "verify", "thread/2");
	q.send(other);
	q.send(file(b, "verify", old.cause));
	const resolve = {
		kind: "resolve_holding",
		work: a,
		lane: "verify",
		cause: old.cause,
	};
	assert.deepEqual(q.send(resolve), []);
	assert.deepEqual(q.send(resolve), []);
	assert.deepEqual(q.send(answer(stale, "resume")), []);
	assert.equal(q.asks().length, 2);
	assert.ok(q.asks().some((ask) => ask.basis.includes(other.evidence)));
	assert.ok(
		q
			.asks()
			.some((ask) => ask.basis.includes(file(b, "verify", old.cause).evidence)),
	);
});

test("the project slot grants each live waiter once in FIFO order; only its holder can pass it on", () => {
	const trunk = project(trunkLane);
	const withdrawn = id(4);
	assert.deepEqual(trunk.send(take(a)), grant(a));
	for (const event of [
		take(withdrawn),
		take(b),
		take(c),
		take(b),
		release(withdrawn),
	])
		assert.deepEqual(trunk.send(event), []);
	assert.deepEqual(trunk.send(release(a)), grant(b));
	assert.deepEqual(
		trunk.send(release(a)),
		[],
		"late release from the previous holder",
	);
	assert.deepEqual(trunk.send(take(b)), [], "request from the current holder");
	assert.deepEqual(trunk.send(release(b)), grant(c));
	assert.deepEqual(trunk.send(release(c)), []);
	assert.deepEqual(trunk.send(take(a)), grant(a));
});
