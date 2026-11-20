import type { Tx } from "tau/durable";
import type { WorkId } from "./ids.ts";
import { ProjectState, WorkState } from "./records.ts";
import { stateDoc } from "./state.ts";

export const project = (tx: Tx) => tx.doc(stateDoc(ProjectState));
export async function ledger(tx: Tx, work: WorkId | null) {
	return work === null
		? (await project(tx)).ledger
		: tx.doc(stateDoc(WorkState), work);
}
