import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";
import type { RepoInfo, Sha } from "../../repo/index.ts";
import type { Approval, Ruling } from "../build/public.ts";
import type { Mandate } from "../design/public.ts";

export type PassedResult = { sha: Sha; evidence: string };

export type FindingNote = { kind: "finding_note"; text: string };
export function findingNote(work: WorkId, text: string): Message {
	const event: FindingNote = { kind: "finding_note", text };
	return { lane: "verify", work, event };
}

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
