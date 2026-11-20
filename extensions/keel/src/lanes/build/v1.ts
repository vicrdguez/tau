// Independent stored shape. Keep this version when introducing a migration.
import type { BranchName, Sha } from "../../repo/index.ts";

type RepoV1 = {
	root: string;
	commonDir: string;
	base: BranchName;
	trunk: BranchName;
	baseHead: Sha;
	trunkHead: Sha | null;
};
type WorkerV1 = {
	kind: "worktree";
	key: string;
	path: string;
	branch: BranchName;
	from: BranchName;
	base: Sha;
};
type MandateV1 = {
	reviewed: boolean;
	intent: string;
	nodes: { label: string; rule: string; probe: string }[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	protectedPaths: string[];
};
type V1 = {
	phase:
		| "idle"
		| "discover"
		| "start"
		| "active"
		| "handed_off"
		| "closed"
		| "cancelled";
	mandate: MandateV1 | null;
	repo: RepoV1 | null;
	branches: { base: string; trunk: string } | null;
	base: Sha | null;
	head: Sha | null;
	seq: number;
	setupSeq: number;
	setupRetry: number;
	refreshTrunk: Sha | null;
	abandoned: WorkerV1[];
	cleanup: {
		worker: WorkerV1;
		mergedHead: Sha | null;
		wait: string | null;
		key: string;
	}[];
	kept: string[];
	coordinator: {
		tool: "publish_plan" | "brief_item" | "handoff_build" | null;
		item: string | null;
		seq: number;
		pendingDirection: string;
		reason: {
			inheritedTrunk: Sha | null;
			kind: "integration" | "rework";
			evidence: string;
			threads: string[];
		} | null;
		direction: string;
	};
	items: {
		id: string;
		kind: "build" | "encode";
		goal: string;
		deps: string[];
		stage:
			| "planned"
			| "preparing"
			| "building"
			| "published"
			| "cleaning"
			| "merged";
		brief: {
			goal: string;
			evidence: string;
			fences: string;
			nodes: string[];
		} | null;
		worker: WorkerV1 | null;
		attempt: number;
		seq: number;
		retry: number;
		mergedHead: Sha | null;
		input: "resume" | "brief" | "rework" | "integration";
		evidence: string;
		threads: string[];
		direction: string;
		rulings: {
			what: string;
			why: string;
			cost: string;
			rank: number;
			follows: string;
		}[];
		publication: {
			sha: Sha;
			summary: string;
			addresses: string[];
			base: Sha;
			protectedChanges: {
				kind: "added" | "modified" | "deleted" | "renamed";
				path: string;
				before: string;
				after: string;
			}[];
			trunk: Sha | null;
		} | null;
	}[];
	holds: {
		cause: string;
		item: string | null;
		evidence: string;
		obstruction: string;
		actual: Sha | null;
	}[];
};
export const buildV1 = {
	version: 1,
	sample: (): V1 => ({
		phase: "idle",
		mandate: null,
		repo: null,
		branches: null,
		base: null,
		head: null,
		seq: 0,
		setupSeq: 0,
		setupRetry: 0,
		refreshTrunk: null,
		abandoned: [],
		cleanup: [],
		kept: [],
		coordinator: {
			tool: null,
			item: null,
			seq: 0,
			reason: null,
			pendingDirection: "",
			direction: "",
		},
		items: [],
		holds: [],
	}),
};
