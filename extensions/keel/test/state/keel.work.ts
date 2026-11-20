import type { ConversationId, TaskId } from "tau/durable";
import { type Token, token } from "../../src/kernel/ids.ts";
import type { WorkState } from "../../src/kernel/records.ts";
import type { Check, Exact } from "./fixture.ts";

export type V1 = {
	agents: Record<
		string,
		{
			conversation: ConversationId;
			role: string;
			used: Token[];
			stop: TaskId | null;
			cwd: string | null;
			status: "active" | "paused" | "retired";
			open: { token: Token; tools: string[]; unsolicited: boolean }[];
		}
	>;
	effects: Record<
		string,
		{ task: TaskId; status: "planned" | "running" | "cancelled" | "done" }
	>;
};
export type CurrentMatchesV1 = Check<
	Exact<V1, ReturnType<typeof WorkState.initial>>
>;

export const current = {
	agents: {
		worker: {
			conversation: 11 as ConversationId,
			role: "worker",
			used: [token("worker", 1), token("worker", 2)],
			stop: null,
			cwd: "/work",
			status: "active",
			open: [
				{ token: token("worker", 2), tools: ["publish"], unsolicited: false },
			],
		},
	},
	effects: { checkout: { task: 12 as TaskId, status: "running" } },
} satisfies V1;
