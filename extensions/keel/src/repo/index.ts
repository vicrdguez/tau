import { realpath } from "node:fs/promises";
import {
	branch,
	buildWork,
	type Exec,
	Git,
	key,
	moved,
	occupied,
	report,
} from "./git.ts";
import { integrate, landingCommit } from "./integrate.ts";
import type {
	Landing,
	PublishResult,
	RepoInfo,
	RepoOp,
	RepoResult,
	Worker,
} from "./types.ts";
import {
	advance,
	creation,
	dirt,
	inspect,
	markdown,
	materialize,
	remove,
	workerSpec,
	zlist,
} from "./worktrees.ts";

export { type Exec, layout, nodeExec } from "./git.ts";
export type * from "./types.ts";

function roles(base: string, trunk: string) {
	if (
		branch(base).toLowerCase() === branch(trunk).toLowerCase() ||
		trunk.toLowerCase() === "main" ||
		[base, trunk].some((s) => /^keel(?:\/|$)/i.test(s))
	)
		throw new TypeError(
			"trunk cannot be main; base, trunk and the keel branch namespace must be disjoint",
		);
}

export async function readRepo(
	exec: Exec,
	cwd: string,
	{ base = "main", trunk = "trunk" }: { base?: string; trunk?: string } = {},
): Promise<RepoInfo> {
	roles(base, trunk);
	const g = new Git(exec, cwd);
	const root = await realpath(
		(await g.output("rev-parse", "--show-toplevel")).replace(/\n$/, ""),
	);
	const commonDir = await realpath(
		(
			await g.output("rev-parse", "--path-format=absolute", "--git-common-dir")
		).replace(/\n$/, ""),
	);
	const baseHead = await g.head(branch(base));
	if (baseHead === null) throw Error("base branch is absent: " + base);
	return {
		root,
		commonDir,
		base: branch(base),
		trunk: branch(trunk),
		baseHead,
		trunkHead: await g.head(branch(trunk)),
	};
}

/** Given a persisted key and spec, materialize an unreferenced candidate.
 * Persist its result as land.target before the CAS. If trunk moved, verify THIS
 * sha while holding the landing slot: land cannot substitute a tree. */
export function prepareLanding(exec: Exec, repo: RepoInfo, plan: Landing) {
	return landingCommit(new Git(exec, repo.commonDir), plan);
}

/** The kernel serializes operations for a build, and does not cancel an in-flight land. */
export function converge(
	exec: Exec,
	repo: RepoInfo,
	op: RepoOp,
): Promise<RepoResult> {
	return report(async (): Promise<RepoResult> => {
		roles(repo.base, repo.trunk);
		key(op.key);
		const g = new Git(exec, repo.commonDir);
		switch (op.kind) {
			case "start_build": {
				buildWork(op.branch);
				const base = repo.trunkHead ?? repo.baseHead;
				if (await creation(g, op.branch, base, op.key))
					return { kind: "started", base };
				const at = await g.head(repo.trunk);
				if (
					(at !== null && at !== base) ||
					(at === null && repo.trunkHead !== null)
				)
					moved(at);
				if (
					repo.trunkHead === null &&
					!(await creation(g, repo.trunk, base, op.key))
				)
					await advance(g, repo.trunk, null, base, op.key);
				await advance(g, op.branch, null, base, op.key);
				return { kind: "started", base };
			}
			case "worktree":
				await materialize(g, repo, op);
				return {
					kind: "worktree",
					base: op.base,
					principles: await markdown(g, op.base, ".keel/principles"),
				};
			case "checkout":
				await materialize(g, repo, op);
				return {
					kind: "checkout",
					playbook:
						(await markdown(g, op.sha, ".keel/playbooks")).find(
							(f) => f.name === "verify",
						)?.body ?? null,
				};
			case "remove":
				return remove(g, repo, op.target);
			case "merge_item":
			case "take_trunk":
				return integrate(g, repo, op);
			case "land": {
				const at = await g.head(repo.trunk);
				if (at === op.target) return { kind: "landed", sha: at };
				if (at !== op.expectedTrunk) moved(at);
				const target = await landingCommit(g, op);
				if (target !== op.target)
					throw new TypeError("stored target does not match landing plan");
				await advance(g, repo.trunk, op.expectedTrunk, target, op.key);
				return { kind: "landed", sha: target };
			}
		}
	});
}

/** No model-supplied revision or pathspec magic. Disabling rename detection makes
 * moving a protected file OUT of a protected directory visible as a deletion. */
export function readPublishable(
	exec: Exec,
	repo: RepoInfo,
	worker: Worker,
	protectedGlobs?: readonly string[],
): Promise<PublishResult> {
	return report(async (): Promise<PublishResult> => {
		workerSpec(repo, worker);
		const g = new Git(exec, repo.commonDir);
		const owned = await inspect(g, repo, worker);
		if (!owned) occupied(worker.path);
		const files = await dirt(owned.wt);
		if (files.length) return { kind: "dirty", files };
		if (!(await g.ancestor(worker.base, owned.head)))
			return { kind: "not_descendant" };
		const paths = protectedGlobs?.map((glob) => ":(top,glob)" + glob);
		const touched =
			paths?.length === 0
				? []
				: zlist(
						await g.output(
							"diff",
							"--no-ext-diff",
							"--no-textconv",
							"--no-renames",
							"--ignore-submodules=none",
							"--name-only",
							"-z",
							worker.base,
							owned.head,
							"--",
							...(paths ?? []),
						),
					);
		const at = await g.head(worker.branch);
		if (at !== owned.head) moved(at);
		return { kind: "ok", sha: owned.head, touched };
	});
}
