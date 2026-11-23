// Drive a lane's reducer, facts and declarations without a kernel or Git.
// These actions return observations, never expected results or automatic routing.
import assert from "node:assert/strict";
import type { ConversationId, JsonObject } from "tau/durable";
import { workId } from "../../src/kernel/ids.ts";
import type {
	KernelEvent,
	Lane,
	LaneEvent,
	World,
} from "../../src/kernel/lane.ts";

export function laneWorld(
	overrides: Partial<Omit<World, "options">> & {
		options?: Partial<World["options"]>;
	} = {},
): World {
	const { options, ...world } = overrides;
	return {
		work: workId(32 as ConversationId),
		root: "/repo",
		now: 1,
		view: () => null,
		...world,
		options: {
			design: "x/design",
			build: "x/build",
			verify: "x/verify",
			queue: "x/queue",
			base: "main",
			trunk: "trunk",
			max_workers: 1,
			...options,
		},
	};
}

/** JSON stand-ins are sufficient for the kernel's branded IDs at this seam. */
export function drive<S extends JsonObject>(
	lane: Lane<S>,
	state: S,
	event: LaneEvent,
	world: World,
) {
	switch (event.kind) {
		case "answered":
		case "effect_done":
		case "effect_failed":
		case "effect_stopped":
		case "agent_stalled":
			return lane.onFact(state, event as KernelEvent, world);
		default:
			return lane.reduce(state, event, world);
	}
}

export function laneDriver<S extends JsonObject>(
	lane: Lane<S>,
	world = laneWorld(),
) {
	let state = lane.state.initial();
	const attempt = (event: LaneEvent) => drive(lane, state, event, world);
	const send = (event: LaneEvent) => {
		const result = attempt(event);
		if ("reject" in result) assert.fail(result.reject);
		state = result.state;
		return result;
	};
	const effects = () => lane.effects(state, world);
	return {
		attempt,
		send,
		effects,
		state: () => state,
		view: () => lane.view(state),
		agents: () => lane.agents(state, world),
		asks: () => lane.asks(state, world),
		done(result: JsonObject, key = effects()[0]?.key) {
			assert.ok(key, "no pending effect to complete");
			return send({ kind: "effect_done", key, result });
		},
		restore: () => {
			state = JSON.parse(JSON.stringify(state));
		},
	};
}
