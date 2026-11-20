import type { WorkId } from "../../kernel/ids.ts";

// Version-one storage contract, independent of the reducer's types.
type QueueV1 = {
	findings: {
		work: WorkId;
		lane: "design" | "build" | "verify";
		item: string | null;
		cause: string;
		evidence: string;
		goal: string;
		resume: string;
		allow?: boolean;
		status: "open" | "resumed" | "allowed" | "cancelled";
	}[];
};
export const queueFixture = {
	version: 1,
	sample: (): QueueV1 => ({
		findings: [
			{
				work: 1 as WorkId,
				lane: "verify",
				item: "i1",
				cause: "thread/1",
				evidence: "The predicate still fails after two fixes.",
				status: "open",
				goal: "Check the predicate.",
				resume: "Send the evidence to the worker for rework.",
			},
		],
	}),
};
