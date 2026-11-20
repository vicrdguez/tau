import type { RepoInfo, Sha } from "../../repo/index.ts";
import type { Ruling } from "../build/public.ts";
import type { Mandate } from "../design/public.ts";

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
				addresses: string[];
				brief: string;
		  }
		| { kind: "handoff"; base: Sha; summary: string; risk: string }
	);
