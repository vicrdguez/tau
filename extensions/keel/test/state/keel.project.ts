import type { DecisionId } from "tau";
import type { ConversationId } from "tau/durable";
import { type WorkId, workId } from "../../src/kernel/ids.ts";
import type { ProjectState } from "../../src/kernel/records.ts";
import type { AddressV1, Check, Exact } from "./fixture.ts";
import * as work from "./keel.work.ts";

export type V1 = {
	anchor: ConversationId | null;
	works: WorkId[];
	asks: Record<
		string,
		AddressV1 & { local: string; decision: DecisionId; signature: string }
	>;
	ledger: work.V1;
};
export type CurrentMatchesV1 = Check<
	Exact<V1, ReturnType<typeof ProjectState.initial>>
>;

const anchor = 10 as ConversationId;
export const current = {
	anchor,
	works: [workId(anchor)],
	asks: {
		review: {
			lane: "toy",
			work: workId(anchor),
			local: "review",
			decision: "keel:10:toy:review#1",
			signature: "basis-A",
		},
	},
	ledger: work.current,
} satisfies V1;
