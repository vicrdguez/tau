import type { DecisionId } from "tau";
import type { ConversationId, TaskId } from "tau/durable";
import type { ProjectPrincipleFile } from "../repo/index.ts";
import type { AgentKey, Token, WorkId } from "./ids.ts";
import { defineState } from "./state.ts";

export type Address = { lane: string; work: WorkId | null };
export type AskSlot = Address & {
	local: string;
	decision: DecisionId;
	signature: string;
};
export type AgentSlot = {
	conversation: ConversationId;
	role: string;
	used: Token[];
	stop: TaskId | null;
	cwd: string | null;
	status: "active" | "paused" | "retired";
	open: { token: Token; tools: string[]; unsolicited: boolean }[];
};
export type EffectSlot = {
	task: TaskId;
	status: "planned" | "running" | "cancelled" | "done";
};
export type Ledger = {
	agents: Record<string, AgentSlot>;
	effects: Record<string, EffectSlot>;
};

export type ProjectState = {
	root: string | null;
	anchor: ConversationId | null;
	works: WorkId[];
	asks: Record<string, AskSlot>;
	ledger: Ledger;
};
export type WorkState = Ledger;
export type BindingState = {
	binding: (Address & { key: AgentKey; role: string }) | null;
	projectPrinciples: ProjectPrincipleFile[] | null;
};
export type ReceiptState = {
	reply: string | null;
	terminate: boolean;
	isError: boolean;
};

const emptyLedger = (): Ledger => ({ agents: {}, effects: {} });

export const ProjectState = defineState<ProjectState>({
	kind: "keel.project",
	version: 1,
	scope: "session",
	initial: () => ({
		root: null,
		anchor: null,
		works: [],
		asks: {},
		ledger: emptyLedger(),
	}),
});
export const WorkState = defineState<WorkState>({
	kind: "keel.work",
	version: 1,
	scope: "conversation",
	initial: emptyLedger,
});
export const BindingState = defineState<BindingState>({
	kind: "keel.binding",
	version: 1,
	scope: "conversation",
	initial: () => ({ binding: null, projectPrinciples: null }),
});
export const ReceiptState = defineState<ReceiptState>({
	kind: "keel.receipt",
	version: 1,
	scope: "task",
	initial: () => ({ reply: null, terminate: false, isError: false }),
});
