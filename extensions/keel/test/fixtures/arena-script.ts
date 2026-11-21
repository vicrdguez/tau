import assert from "node:assert/strict";
import type { FauxResponseStep } from "tau/testing";
import { fauxAssistantMessage } from "tau/testing";

export const seats = ["arena_seat_1", "arena_seat_2"] as const;
export const arenaFrame = {
	question: "What should the repository's first shared interface be?",
	rubric: "Prefer clear callers and a falsifying probe.",
};
export const candidate = (seat: string) =>
	`## Usage\nCall from ${seat}\n\n## Sketch\nSketch of ${seat}\n\n## Rationale\nRationale of ${seat}\n\n## Unasked Decisions\nNaming default from ${seat}`;
export const judgeReport = JSON.stringify({
	base: seats[0],
	scores: seats.map((seat, i) => ({
		seat,
		score: 9 - i,
		reason: `Score justified for ${seat}`,
		unaskedDecisions: [`Naming default from ${seat}`],
	})),
});
export const grafts = [
	{
		seat: seats[1],
		label: "contract",
		text: "Take the independent test boundary.",
	},
];
export const candidateOutcome = (seat: string) => ({
	source: seat,
	n: 1,
	kind: "not_taken",
	reason: "The interface does not establish a naming default.",
});
export const objection = "Will the next implementation copy an unsafe default?";
export const challengerReport = JSON.stringify({ objections: [objection] });
export const dispositions = [
	{
		n: 1,
		status: "considered",
		reason: "Use the approved reference, not the nearest incidental choice.",
	},
];

export function candidateResponse(
	seat: string,
	prompts?: string[],
): FauxResponseStep {
	return ({ messages }) => {
		const prompt = JSON.stringify(
			messages.filter((m) => m.role === "user").at(-1),
		);
		assert.match(prompt, /clear callers/);
		prompts?.push(prompt.replace(/,"timestamp":\d+/, ""));
		return fauxAssistantMessage(candidate(seat));
	};
}
