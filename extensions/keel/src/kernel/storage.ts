import type { ConversationId, Tx } from "tau/durable";
import { slotKey, type WorkId } from "./ids.ts";
import {
	type BindingState,
	type Ledger,
	ProjectState,
	WorkState,
} from "./records.ts";
import { stateDoc } from "./state.ts";

export const project = (tx: Tx) => tx.doc(stateDoc(ProjectState));
export async function ledger(tx: Tx, work: WorkId | null) {
	return work === null
		? (await project(tx)).ledger
		: tx.doc(stateDoc(WorkState), work);
}

export function activeSlot(
	ledger: Readonly<Ledger> | undefined,
	binding: NonNullable<BindingState["binding"]>,
	conversation: ConversationId,
) {
	const slot = ledger?.agents[slotKey(binding.lane, binding.key)];
	if (
		slot?.status === "active" &&
		slot.conversation === conversation &&
		slot.role === binding.role
	)
		return slot;
}
