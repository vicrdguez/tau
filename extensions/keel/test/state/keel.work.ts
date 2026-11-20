import type { ConversationId, TaskId } from "tau/durable";
import { type Token, token } from "../../src/kernel/ids.ts";
import type { WorkState } from "../../src/kernel/records.ts";
import type { Check, Exact, RoleV1 } from "./fixture.ts";

export type V1 = {
	agents: Record<
		string,
		{
			conversation: ConversationId;
			role: RoleV1;
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
			cwd: "/work",
			status: "active",
			open: [
				{ token: token("worker", 2), tools: ["publish"], unsolicited: false },
			],
		},
	},
	effects: { checkout: { task: 12 as TaskId, status: "running" } },
} satisfies V1;
