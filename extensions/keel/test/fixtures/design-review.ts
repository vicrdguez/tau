import assert from "node:assert/strict";
import type { LaneEvent, World } from "../../src/kernel/lane.ts";
import { design } from "../../src/lanes/design/index.ts";
import { arenaFrame, candidate, judgeReport, seats } from "./arena-script.ts";

export const crossFamilyOptions = {
	arena_seat_2: "candidate/second",
	arena_judge: "judge/reader",
};
export const synthesis = { base: seats[0], grafts: [] };
export const reviewChoices = [
	"approve",
	"rework",
	...seats.map((seat) => `base:${seat}`),
	"arena",
	"arena_fresh",
	"decline",
];

type Driver = {
	act(event: LaneEvent): unknown;
	state(): ReturnType<typeof design.state.initial>;
};
function complete(x: Driver, world: World, answer: (seat: string) => string) {
	const [effect] = design.effects(x.state(), world);
	assert.ok(effect);
	const jobs = effect.spec.jobs as { seat: string }[];
	x.act({
		kind: "effect_done",
		key: effect.key,
		result: {
			results: jobs.map(({ seat }, i) => ({
				seat,
				conversation: `${effect.key}/${i}`,
				answer: answer(seat),
				error: null,
			})),
		},
	});
}
export function frameReview(x: Driver, world: World) {
	x.act({ kind: "frame_arena", ...arenaFrame });
	complete(x, world, candidate);
	complete(x, world, () => judgeReport);
}
export function challengeReview(x: Driver, world: World) {
	if (x.state().phase === "review") return;
	complete(x, world, () => '{"objections":[]}');
	x.act({ kind: "answer_challenger", dispositions: [] });
}
