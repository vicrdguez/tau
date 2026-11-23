import type { ConversationId } from "tau/durable";
import { workId } from "../../src/kernel/ids.ts";
import * as work from "./keel.work.ts";

const anchor = 10 as ConversationId;
export const current = {
	anchor,
	root: "/projects/quant-engine",
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
};
