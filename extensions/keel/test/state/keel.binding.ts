import type { ConversationId } from "tau/durable";
import { type AgentKey, agentKey, workId } from "../../src/kernel/ids.ts";
import type { BindingState } from "../../src/kernel/records.ts";
import type { AddressV1, Check, Exact } from "./fixture.ts";

export type V1 = {
	binding: (AddressV1 & { key: AgentKey; role: string }) | null;
	projectPrinciples: { readonly name: string; readonly body: string }[] | null;
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
	projectPrinciples: [{ name: "money", body: "Pinned source" }],
} satisfies V1;
