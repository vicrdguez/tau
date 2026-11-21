import { realpath } from "node:fs/promises";
import {
	branch,
	buildWork,
	type Exec,
	Git,
	key,
	moved,
	occupied,
	oid,
	report,
	success,
} from "./git.ts";
import { integrate, landingCommit } from "./integrate.ts";
import type {
	PublishResult,
	RepoInfo,
	RepoOp,
	RepoResult,
	Sha,
	Worker,
} from "./types.ts";
import {
	advance,
	creation,
	dirt,
	inspect,
	landedSince,
	markdown,
	materialize,
	ownedBranch,
	remove,
	workerSpec,
	zlist,
} from "./worktrees.ts";

export { type Exec, layout, nodeExec } from "./git.ts";
export type * from "./types.ts";

export function readCheckoutHead(exec: Exec, cwd: string): Promise<Sha | null> {
	return new Git(exec, cwd).checkoutHead();
}

function roles(base: string, trunk: string) {
	if (
		branch(base).toLowerCase() === branch(trunk).toLowerCase() ||
		trunk.toLowerCase() === "main" ||
		[base, trunk].some((s) => /^(?:HEAD$|(?:refs|keel)(?:\/|$))/i.test(s))
	)
		throw new TypeError(
			"base and trunk must be distinct short branch names outside keel; trunk cannot be main",
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

/** The caller serializes conflicting ref updates; see README.md. */
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
				) {
					if (at && (await landedSince(g, repo.trunk, base, at)))
						return { kind: "moved", actual: at, keelMoved: true };
					moved(at);
				}
				if (repo.trunkHead === null && !(await creation(g, repo.trunk, base)))
					await advance(g, repo.trunk, null, base, op.key, true);
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
				return remove(g, repo, op);
			case "merge_item":
			case "take_trunk":
				return integrate(g, repo, op);
			case "prepare_landing": {
				const sha = await landingCommit(g, op.landing);
				if (sha !== op.landing.expectedTrunk) return { kind: "prepared", sha };
				const at = await g.head(repo.trunk);
				if (at !== sha) moved(at);
				return { kind: "unchanged", sha };
			}
			case "land": {
				const at = await g.head(repo.trunk);
				if (at === op.target && at !== op.expectedTrunk)
					return { kind: "landed", sha: at };
				if (at !== op.expectedTrunk) moved(at);
				const target = await landingCommit(g, op);
				if (target !== op.target)
					throw new TypeError("stored target does not match landing plan");
				if (target === op.expectedTrunk)
					return { kind: "unchanged", sha: target };
				await advance(g, repo.trunk, op.expectedTrunk, target, op.key);
				return { kind: "landed", sha: target };
			}
		}
	});
}

/** Use the build history and any trusted trunk pin the worker actually took.
 * In a criss-cross history neither best base alone contains all inherited work. */
async function comparisonBase(
	g: Git,
	build: Sha,
	item: Sha,
	inheritedTrunk: Sha | null,
): Promise<Sha> {
	const bases = (await g.output("merge-base", "--all", build, item))
		.trimEnd()
		.split("\n")
		.sort()
		.map((b) => oid(b) as Sha);
	if (inheritedTrunk && (await g.ancestor(inheritedTrunk, item)))
		bases.push(inheritedTrunk);
	let base = bases[0]!;
	for (const other of bases.slice(1)) {
		if (other === base || (await g.ancestor(other, base))) continue;
		if (await g.ancestor(base, other)) {
			base = other;
			continue;
		}
		const merge = await g.run(
			"merge-tree",
			"--write-tree",
			"--name-only",
			"--no-messages",
			"-z",
			base,
			other,
		);
		// Even a conflicted comparison tree is only a diff aid, never merged.
		if (merge.code !== 1) success(merge);
		base = await g.commit(
			zlist(merge.stdout)[0]!,
			[base, other],
			"comparison",
			"Inherited inputs",
		);
	}
	return base;
}

export function readPublishable(
	exec: Exec,
	repo: RepoInfo,
	worker: Worker,
	inheritedTrunk: Sha | null = null,
): Promise<PublishResult> {
	return report(async (): Promise<PublishResult> => {
		workerSpec(repo, worker);
		const g = new Git(exec, repo.commonDir);
		const owned = await inspect(g, repo, worker);
		if (!owned) occupied(worker.path);
		if (owned.head === null) moved(null);
		const files = await dirt(owned.wt);
		if (files.length) return { kind: "dirty", files };
		if (!(await g.ancestor(worker.base, owned.head)))
			return { kind: "not_descendant" };
		const build = await g.head(worker.from);
		if (build === null) moved(null);
		await ownedBranch(g, worker.from);
		const sha = owned.head;
		const base = await comparisonBase(g, build, sha, inheritedTrunk);
		// Treat renames as deletes and adds so both in-scope names are listed.
		const changedPolicyFiles = zlist(
			await g.output(
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--ignore-submodules=none",
				"--name-only",
				"-z",
				base,
				sha,
				"--",
				":(top,icase,literal).keel/principles",
				":(top,icase,literal).keel/playbooks",
			),
		).sort();
		const at = await g.head(worker.branch);
		if (at !== sha) moved(at);
		return { kind: "ok", sha, base, changedPolicyFiles };
	});
}
