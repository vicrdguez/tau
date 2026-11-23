import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId } from "tau/durable";
import { type WorkId, workId } from "../src/kernel/ids.ts";
import type { LaneEvent, RegisteredLane } from "../src/kernel/lane.ts";
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
			send: (event: LaneEvent) => driver.send(event).send ?? [],
		};
	});
}
const take = (work: WorkId) => ({ kind: "take_slot", work });
const release = (work: WorkId) => ({ kind: "release_slot", work });
const grant = (work: WorkId) => [
	{ lane: "verify", work, event: { kind: "slot_granted" } },
];

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
