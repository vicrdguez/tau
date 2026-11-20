declare const commitHash: unique symbol;
declare const branchName: unique symbol;
export type Sha = string & { readonly [commitHash]: true };
export type BranchName = string & { readonly [branchName]: true };

/** Snapshot at planning time. Persist this and the op before calling converge. */
export type RepoInfo = Readonly<{
	root: string;
	commonDir: string;
	base: BranchName;
	trunk: BranchName;
	baseHead: Sha;
	trunkHead: Sha | null;
}>;

/** Designer-written, replay-safe commands stored in the Mandate, never merge-time tool arguments. */
export type Check = Readonly<{
	id: string;
	argv: readonly string[];
	timeoutMs: number;
}>;
export type CheckReport = Readonly<{ id: string; code: number; tail: string }>;
export type ProofChanges = Readonly<{
	paths: readonly string[];
	headChanged: boolean;
}>;
export type ProjectPrincipleFile = Readonly<{ name: string; body: string }>;

export type Worker = Readonly<{
	kind: "worktree";
	key: string;
	path: string;
	branch: BranchName;
	from: BranchName;
	base: Sha;
}>;
export type Checkout = Readonly<{
	kind: "checkout";
	key: string;
	path: string;
	sha: Sha;
}>;
export type Landing = Readonly<{
	key: string;
	expectedTrunk: Sha;
	combined: Sha;
	message: string;
}>;
export type Integrate = { readonly protectedGlobs?: readonly string[] } & (
	| Readonly<{
			kind: "merge_item";
			key: string;
			integration: string;
			into: BranchName;
			expected: Sha;
			item: Sha;
			checks: readonly Check[];
			message: string;
	  }>
	| Readonly<{
			kind: "take_trunk";
			key: string;
			integration: string;
			build: BranchName;
			expected: Sha;
			trunk: Sha;
			checks: readonly Check[];
	  }>);
export type Remove = Readonly<{
	kind: "remove";
	key: string;
	target: Worker | (Omit<Checkout, "sha"> & { readonly sha?: Sha });
	merged?: boolean;
	mergedHead?: Sha;
}>;
export type RepoOp =
	| Readonly<{ kind: "start_build"; key: string; branch: BranchName }>
	| Worker
	| Checkout
	| Remove
	| Integrate
	| Readonly<{ kind: "prepare_landing"; key: string; landing: Landing }>
	| (Landing & Readonly<{ kind: "land"; target: Sha }>);

export type Obstruction =
	| { kind: "occupied"; path: string }
	| { kind: "moved"; actual: Sha | null };
export type RepoResult =
	| Obstruction
	| { kind: "started"; base: Sha }
	| { kind: "worktree"; base: Sha; principles: readonly ProjectPrincipleFile[] }
	| { kind: "checkout"; playbook: string | null }
	| { kind: "removed" }
	| { kind: "kept"; reason: string; files: readonly string[] }
	| { kind: "merged"; touched?: readonly string[]; sha: Sha; checks: readonly CheckReport[] }
	| { kind: "combined"; touched?: readonly string[]; sha: Sha; trunk: Sha; checks: readonly CheckReport[] }
	| { kind: "conflict"; paths: readonly string[]; against: Sha }
	| {
			kind: "checks_failed";
			touched?: readonly string[];
			sha: Sha;
			checks: readonly CheckReport[];
			changes?: ProofChanges;
	  }
	| { kind: "prepared"; sha: Sha }
	| { kind: "unchanged"; sha: Sha }
	| { kind: "landed"; sha: Sha };

export type PublishResult =
	| Obstruction
	| { kind: "ok"; sha: Sha; touched: readonly string[] }
	| { kind: "dirty"; files: readonly string[] }
	| { kind: "not_descendant" };
