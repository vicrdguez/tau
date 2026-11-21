import type { RepoInfo, Sha } from "../../repo/index.ts";
import type { Ruling } from "../build/public.ts";
import type { Mandate, Reply } from "../design/public.ts";

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
				approvalReplies: Reply[];
		  }
	);
