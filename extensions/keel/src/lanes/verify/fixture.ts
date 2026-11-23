// Stored version 1, independent of the reducer. Keep this snapshot when the state changes.
import type { BranchName, Sha } from "../../repo/index.ts";

type RepoV1 = {
	root: string;
	commonDir: string;
	base: BranchName;
	trunk: BranchName;
	baseHead: Sha;
	trunkHead: Sha | null;
};
type ProofV1 = { id: string; argv: string[]; timeoutMs: number };
type MandateV1 = {
	encodeRequired: boolean;
	approvalNotes: string[];
	intent: string;
	delegated: {
		label: string;
		text: string;
		origin: "evidence" | "incidental" | "seeded";
	}[];
	nodes: (
		| { label: string; rule: string; probe: string }
		| { label: string; section: string; body: string }
	)[];
	checks: ProofV1[];
	considerations: { tradeoffs: string; alternatives: string } | null;
};
type RulingV1 = {
	what: string;
	why: string;
	cost: string;
	rank: number;
	follows: string;
	principles: string[];
};
type CheckoutV1 = { kind: "checkout"; key: string; path: string; sha: Sha };
type PlanV1 = {
	key: string;
	combined: Sha;
	expectedTrunk: Sha;
	message: string;
};
type OpV1 =
	| CheckoutV1
	| {
			kind: "remove";
			key: string;
			target: CheckoutV1 | { kind: "checkout"; key: string; path: string };
	  }
	| {
			kind: "merge_item";
			key: string;
			integration: string;
			into: BranchName;
			expected: Sha;
			item: Sha;
			checks: ProofV1[];
			message: string;
	  }
	| {
			kind: "take_trunk";
			key: string;
			integration: string;
			build: BranchName;
			expected: Sha;
			trunk: Sha;
			checks: ProofV1[];
	  }
	| { kind: "prepare_landing"; key: string; landing: PlanV1 }
	| ({ kind: "land"; target: Sha } & PlanV1)
	| { kind: "read_repo"; key: string; base: BranchName; trunk: BranchName };
type ScopeV1 = "item" | "full" | "landing";
type BlockV1 = { thread: string; ground: string; evidence: string };
type V1 = {
	seq: number;
	cancelled: boolean;
	kept: string[];
	queueHolds: { item: string; cause: string }[];
	directions: string[];
	diagnoses: string[];
	repo: RepoV1 | null;
	mandate: MandateV1 | null;
	head: Sha | null;
	checks: {
		item: string;
		scope: ScopeV1;
		sha: Sha;
		base: Sha;
		brief: string;
		paths: string[];
		nodes: string[];
		obsolete: {
			evidence: string;
			reason: "mandate_revision" | "defect_fixed";
		} | null;
		rulings: RulingV1[];
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
		checkout: CheckoutV1 | null;
		direction: string;
		changedPolicyFiles: string[];
		playbook: string | null;
	}[];
	jobs: { item: string; key: string; op: OpV1 }[];
	holds: {
		item: string;
		cause: string;
		job: string | null;
		evidence: string;
	}[];
	verdicts: {
		item: string;
		scope: ScopeV1;
		sha: Sha;
		outcome: "pass" | "fail";
		text: string;
		blocks: BlockV1[];
		diagnose: string[];
		notes: string[];
		addresses: string[];
	}[];
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
		rulings: RulingV1[];
		approvals: {
			revision: number | null;
			notes: {
				n: number;
				status: "acted_on" | "considered" | "dismissed";
				reason: string;
				text: string;
			}[];
		}[];
	} | null;
	slot: "none" | "waiting" | "held";
	plan: PlanV1 | null;
	target: Sha | null;
	landingUnconfirmed: boolean;
	handover: {
		sha: Sha;
		at: number;
		unchanged: boolean;
		status: "asking" | "accepted" | "rejected";
		followReference: string | null;
		revisions: string;
		findings: string;
	} | null;
};
export const verifyFixture = {
	version: 1,
	sample: (): V1 => ({
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
};
