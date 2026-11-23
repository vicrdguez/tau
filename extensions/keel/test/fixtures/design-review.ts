import assert from "node:assert/strict";
import type { LaneEvent, World } from "../../src/kernel/lane.ts";
import { design } from "../../src/lanes/design/index.ts";
import {
	arenaFrame,
	candidate,
	candidateOutcome,
	judgeReport,
	seats,
} from "./arena-script.ts";
import { laneDriver, laneWorld } from "./drive.ts";

export const designWorld = laneWorld({
	options: {
		arena_seat_2: "candidate/second",
		arena_judge: "judge/reader",
	},
});
export const synthesis = {
	base: seats[0],
	grafts: [],
	outcomes: [candidateOutcome(seats[0])],
};
export const reviewChoices = [
	"approve",
	"rework",
	"base:arena_seat_1",
	"base:arena_seat_2",
	"arena",
	"arena_fresh",
	"decline",
];

type Driver = ReturnType<
	typeof laneDriver<ReturnType<typeof design.state.initial>>
>;
export function dispatchResult(
	effect: ReturnType<typeof design.effects>[number],
	answer: (seat: string) => string | null,
) {
	return {
		results: (effect.spec.jobs as { seat: string }[]).map(({ seat }, i) => {
			const text = answer(seat);
			return {
				seat,
				conversation: `${effect.key}/${i}`,
				answer: text,
				error: text === null ? "Child timed out." : null,
			};
		}),
	};
}
function complete(x: Driver, answer: (seat: string) => string) {
	const [effect] = x.effects();
	assert.ok(effect);
	x.done(dispatchResult(effect, answer));
}
export function reviewDriver(world: World = designWorld) {
	const x = laneDriver(design, world);
	const frame = () => {
		x.send({ kind: "frame_arena", ...arenaFrame });
		complete(x, candidate);
		complete(x, () => judgeReport);
	};
	const publishMandate = (event: LaneEvent) => {
		if (x.state().phase === "framing") frame();
		x.send({ ...synthesis, ...event });
		if (x.state().phase !== "review") {
			complete(x, () => '{"objections":[]}');
			x.send({ kind: "answer_challenger", dispositions: [] });
		}
	};
	const turn = () => x.agents()[0]?.expects[0];
	return {
		...x,
		frame,
		publishMandate,
		turn,
		input: () => turn()?.input?.() ?? "",
		mandate: () => x.state().mandate!,
		answer(
			subject: string,
			choice: string,
			annotations: {
				n: number;
				text: string;
				range?: { start: number; end: number };
			}[] = [],
		) {
			return x.send({
				kind: "answered",
				subject,
				choice,
				annotations,
				decision: `${subject}#1`,
			});
		},
	};
}
