import { defineState } from "../../kernel/state.ts";
import type {
	BranchName,
	Checkout,
	Landing,
	RepoInfo,
	Sha,
} from "../../repo/index.ts";
import type { Approval, Ruling } from "../build/public.ts";
import type { Mandate } from "../design/public.ts";

export type Block = { thread: string; ground: string; evidence: string };
export type Scope = "item" | "full" | "landing";
export type Review = {
	item: string;
	scope: Scope;
	sha: Sha;
	base: Sha;
	brief: string;
	paths: string[];
	nodes: string[];
	obsolete: {
		evidence: string;
		reason: "mandate_revision" | "defect_fixed";
	} | null;
	rulings: Ruling[];
	addresses: string[];
	phase:
		| "checkout"
		| "verify"
		| "diagnose"
		| "nonconvergent"
		| "returned"
		| "ready"
		| "merging"
		| "merged"
		| "passed";
	turn: number;
	checkout: Checkout | null;
	direction: string;
	changedPolicyFiles: string[];
	playbook: string | null;
	owed: { ids: number[]; text: string } | null;
};
export type Verdict = {
	item: string;
	scope: Scope;
	sha: Sha;
	outcome: "pass" | "fail";
	text: string;
	blocks: Block[];
	diagnose: string[];
	notes: string[];
	addresses: string[];
	encodedChecks: number[];
};
type Integration = {
	key: string;
	integration: string;
	expected: Sha;
	checks: Mandate["checks"];
};
type Merge = Integration & {
	kind: "merge_item";
	into: BranchName;
	item: Sha;
	message: string;
};
export type Target = Checkout | Omit<Checkout, "sha">;
export type Op =
	| Checkout
	| { kind: "remove"; key: string; target: Target }
	| Merge
	| (Integration & { kind: "take_trunk"; build: BranchName; trunk: Sha })
	| { kind: "read_repo"; key: string; base: BranchName; trunk: BranchName }
	| { kind: "prepare_landing"; key: string; landing: Landing }
	| ({ kind: "land"; target: Sha } & Landing);
export type Job = { item: string; op: Op; key: string };
export type State = {
	seq: number;
	cancelled: boolean;
	kept: string[];
	queueHolds: { item: string; cause: string }[];
	directions: string[];
	diagnoses: string[];
	repo: RepoInfo | null;
	mandate: Mandate | null;
	head: Sha | null;
	checks: Review[];
	jobs: Job[];
	holds: {
		item: string;
		cause: string;
		job: string | null;
		evidence: string;
	}[];
	verdicts: Verdict[];
	threads: {
		item: string;
		scope: "item" | "full";
		id: string;
		survived: number;
	}[];
	handoff: {
		base: Sha;
		summary: string;
		risk: string;
		rulings: Ruling[];
		approvals: Approval[];
	} | null;
	slot: "none" | "waiting" | "held";
	plan: Landing | null;
	target: Sha | null;
	landingUnconfirmed: boolean;
	handover: {
		sha: Sha;
		at: number;
		unchanged: boolean;
		status: "asking" | "accepted" | "rejected";
		missing: string[];
		revisions: string;
		findings: string;
		owed: string;
	} | null;
};
export const queueHeld = (s: State, item: string) =>
	s.queueHolds.some((h) => h.item === item);
export const held = (s: State, item: string) =>
	queueHeld(s, item) || s.holds.some((h) => h.item === item);

/** Finish the preceding removal before acting on its successor. The full build depends on all items. */
export function cleaning(s: State, item: string) {
	return s.jobs.some(
		(j) =>
			j.op.kind === "remove" &&
			(j.item === item || j.item === "full" || item === "full"),
	);
}

export const VerifyDoc = defineState<State>({
	kind: "keel.verify",
	scope: "conversation",
	version: 1,
	initial: () => ({
		seq: 0,
		cancelled: false,
		kept: [],
		queueHolds: [],
		directions: [],
		diagnoses: [],
		repo: null,
		mandate: null,
		head: null,
		checks: [],
		jobs: [],
		holds: [],
		verdicts: [],
		threads: [],
		handoff: null,
		slot: "none",
		plan: null,
		target: null,
		landingUnconfirmed: false,
		handover: null,
	}),
});
