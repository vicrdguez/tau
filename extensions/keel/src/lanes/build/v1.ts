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
	encodeRequired: boolean;
	approvalNotes: string[];
	intent: string;
	nodes: (
		| { label: string; rule: string; probe: string }
		| { label: string; section: string; body: string }
	)[];
	delegated: {
		label: string;
		text: string;
		origin: "evidence" | "incidental" | "seeded";
	}[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	considerations: { tradeoffs: string; alternatives: string } | null;
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
	approvals: {
		revision: number | null;
		notes: {
			n: number;
			status: "acted_on" | "considered" | "dismissed";
			reason: string;
			text: string;
		}[];
	}[];
	revision: {
		kind: "propose_revision";
		number: number;
		mandate: MandateV1;
		causes: string[];
		nodes: string[];
		text: string;
	} | null;
	findings: {
		kind: "plan_finding";
		text: string;
		reference: string;
		nodes: string[];
		cause: string | null;
		items: string[];
	}[];
	queueHolds: {
		cause: string;
		items: string[];
		nodes: string[];
		evidence: string;
		forwarded: string[];
	}[];
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
	waitingSetup: string | null;
	coordinator: {
		tool: "publish_plan" | "brief_item" | "handoff_build" | null;
		item: string | null;
		seq: number;
		finding: boolean;
		revising: boolean;
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
		awaitingNodes: string[];
		parked: boolean;
		refreshAfterFix: boolean;
		verified: boolean;
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
			fences: string[];
			nodes: string[];
		} | null;
		worker: WorkerV1 | null;
		projectPrinciples: { name: string; body: string }[];
		attempt: number;
		seq: number;
		retry: number;
		mergedHead: Sha | null;
		input: "resume" | "brief" | "rework" | "integration" | "superseded";
		evidence: string;
		threads: string[];
		direction: string;
		rulings: {
			what: string;
			why: string;
			cost: string;
			rank: number;
			follows: string;
			principles: string[];
		}[];
		publication: {
			sha: Sha;
			summary: string;
			addresses: string[];
			base: Sha;
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
		approvals: [],
		revision: null,
		findings: [],
		queueHolds: [],
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
		waitingSetup: null,
		coordinator: {
			tool: null,
			item: null,
			seq: 0,
			finding: false,
			revising: false,
			reason: null,
			pendingDirection: "",
			direction: "",
		},
		items: [],
		holds: [],
	}),
};
