import type { ConversationId } from "tau/durable";

/** A live task's version-one dispatch plan, as read from SQLite after a kill. */
export function dispatchPlanV1(
	deadline: number,
	children: readonly ConversationId[],
) {
	return {
		deadline,
		jobs: ["first question", "second question"].map((question, i) => ({
			seat: "reader",
			question,
			conversation: children[i]!,
		})),
	};
}
