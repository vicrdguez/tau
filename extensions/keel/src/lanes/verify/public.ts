import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";
import type { RepoInfo, Sha } from "../../repo/index.ts";
import type { Approval, Ruling } from "../build/public.ts";
import type { Mandate } from "../design/public.ts";

export type FindingNote = { kind: "finding_note"; text: string };
export function findingNote(work: WorkId, text: string): Message {
	const event: FindingNote = { kind: "finding_note", text };
	return { lane: "verify", work, event };
}

/** Hand-over evidence, not a decision or a way to resume a lane. */
export type HoldingReport = {
	kind: "holding_report";
	lane: "design" | "build" | "verify";
	item: string | null;
	cause: string;
	evidence: string;
	/** Null on first report; an answer without annotations is the empty string. */
	direction: string | null;
};
export const holdingReport = (
	work: WorkId,
	report: Omit<HoldingReport, "kind">,
): Message => ({
	lane: "verify",
	work,
	event: { kind: "holding_report", ...report },
});

type BuildSnapshot = {
	repo: RepoInfo;
	mandate: Mandate;
	head: Sha;
	rulings: Ruling[];
};
export type Publication = BuildSnapshot &
	(
		| {
				kind: "published";
				item: string;
				sha: Sha;
				base: Sha;
				changedPolicyFiles: string[];
				addresses: string[];
				brief: string;
				paths: string[];
				nodes?: string[];
		  }
		| {
				kind: "handoff";
				base: Sha;
				summary: string;
				risk: string;
				approvals: Approval[];
		  }
	);
