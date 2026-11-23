import type { ConversationId, TaskId } from "tau/durable";
import { token } from "../../src/kernel/ids.ts";
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
	effects: {
		checkout: { task: 12 as TaskId, status: "running", interrupt: null },
		dispatch: {
			task: 13 as TaskId,
			status: "stopping",
			interrupt: 14 as ConversationId,
		},
	},
} satisfies import("tau/durable").JsonObject;
