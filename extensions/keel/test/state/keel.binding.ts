import type { ConversationId } from "tau/durable";
import { type AgentKey, agentKey, workId } from "../../src/kernel/ids.ts";
import type { BindingState } from "../../src/kernel/records.ts";
import type { AddressV1, Check, Exact, RoleV1 } from "./fixture.ts";

export type V1 = {
	binding: (AddressV1 & { key: AgentKey; role: RoleV1 }) | null;
};
export type CurrentMatchesV1 = Check<
	Exact<V1, ReturnType<typeof BindingState.initial>>
>;

export const current = {
	binding: {
		work: workId(10 as ConversationId),
		lane: "toy",
		key: agentKey("worker"),
		role: "worker",
	},
} satisfies V1;
