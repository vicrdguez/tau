import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";

export type Holding = {
	goal: string;
	resume: string;
	allow?: boolean;
	work: WorkId;
	lane: "design" | "build" | "verify";
	item: string | null;
	cause: string;
	evidence: string;
};
export type Resume = {
	kind: "resume" | "allow";
	item: string | null;
	cause: string;
	evidence: string;
	direction: string;
};
// Session address on the envelope, affected work in the finding.
export function fileHolding(finding: Holding): Message {
	return { lane: "queue", work: null, event: { kind: "file", ...finding } };
}
