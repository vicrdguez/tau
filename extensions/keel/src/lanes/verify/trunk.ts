import type { WorkId } from "../../kernel/ids.ts";
import { defineLane } from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import { trunkFixture } from "./trunk-fixture.ts";

type TrunkState = { holder: WorkId | null; waiting: WorkId[] };
const grant = (work: WorkId) => ({
	lane: "verify",
	work,
	event: { kind: "slot_granted" },
});

/** Per-project arbitration only. Verify owns the git plan and its landing result. */
export const trunkLane = defineLane(
	{
		name: "trunk",
		state: defineState({
			kind: "keel.trunk",
			scope: "session",
			version: 1,
			initial: (): TrunkState => ({ holder: null, waiting: [] }),
		}),
		reduce(state, event) {
			const work = event.work as WorkId;
			if (event.kind === "take_slot") {
				if (state.holder === work || state.waiting.includes(work))
					return { state };
				if (state.holder === null)
					return { state: { ...state, holder: work }, send: [grant(work)] };
				return { state: { ...state, waiting: [...state.waiting, work] } };
			}
			if (event.kind !== "release_slot")
				return { reject: `Unknown trunk event: ${event.kind}` };
			if (state.holder !== work) {
				return {
					state: {
						...state,
						waiting: state.waiting.filter((id) => id !== work),
					},
				};
			}
			const [next, ...waiting] = state.waiting;
			return {
				state: { holder: next ?? null, waiting },
				send: next === undefined ? [] : [grant(next)],
			};
		},
		view: (state) => state,
		asks: () => [],
		agents: () => [],
		effects: () => [],
	},
	trunkFixture,
);
