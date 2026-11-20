import type { JsonObject } from "tau/durable";
import type { KernelEvent, Lane, LaneEvent, World } from "../../src/kernel/lane.ts";

/** Direct lane scenarios use JSON stand-ins for the kernel's branded IDs. */
export function drive<S extends JsonObject>(lane: Lane<S>, state: S, event: LaneEvent, world: World) {
	switch (event.kind) {
		case "answered":
		case "effect_done":
		case "effect_failed":
		case "agent_stalled":
			return lane.onFact(state, event as KernelEvent, world);
		default:
			return lane.reduce(state, event, world);
	}
}
