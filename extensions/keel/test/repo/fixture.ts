import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
	converge,
	type Exec,
	type Landing,
	layout,
	nodeExec,
	type RepoOp,
	type RepoResult,
	readPublishable,
	readRepo,
} from "../../src/repo/index.ts";

import { git, tempRepo } from "../fixtures/repo.ts";

export { git } from "../fixtures/repo.ts";
export function is<K extends RepoResult["kind"]>(
	result: RepoResult,
	kind: K,
): asserts result is Extract<RepoResult, { kind: K }> {
	assert.equal(result.kind, kind, JSON.stringify(result));
}
export async function fixture(t: TestContext) {
	const { root } = await tempRepo(t);
	const repo = await readRepo(nodeExec, root);
	const branch = layout.buildBranch("42");
	const start = { kind: "start_build", key: "start:42", branch } as const;
	const base = repo.baseHead;
	const worker = {
		kind: "worktree",
		key: "worker:1",
		path: layout.worktree(repo, "42", "worker 1"),
		branch: layout.itemBranch("42", "book", 1),
		from: branch,
		base,
	} as const;
	const checkout = {
		kind: "checkout",
		key: "verify:1",
		path: layout.worktree(repo, "42", "verify 1"),
		sha: base,
	} as const;
	const run = (op: RepoOp, exec = nodeExec) => converge(exec, repo, op);
	const publish = () => readPublishable(nodeExec, repo, worker);
	async function prepare(plan: Landing) {
		const result = await run({
			kind: "prepare_landing",
			key: `prepare:${plan.key}`,
			landing: plan,
		});
		is(result, "prepared");
		return result.sha;
	}
	async function item() {
		is(await run(start), "started");
		is(await run(worker), "worktree");
		await writeFile(join(worker.path, "book"), "new\n");
		git(worker.path, "commit", "-am", "verified");
		const pub = await publish();
		assert.equal(pub.kind, "ok");
		return {
			kind: "merge_item",
			key: "merge:1",
			integration: layout.integration(repo, "42", "merge:1"),
			into: branch,
			expected: base,
			item: pub.sha,
			checks: [],
			message: "book",
		} as const;
	}
	return {
		root,
		repo,
		start,
		branch,
		base,
		worker,
		checkout,
		run,
		publish,
		prepare,
		item,
	};
}

// Interrupt immediately before and after *successful real Git transactions*. Every restart
// receives only the original plan and disk; no result from the interrupted call escapes.
export async function interrupted(
	run: (exec: Exec) => Promise<RepoResult>,
	mutations: readonly string[][],
) {
	for (const words of mutations) {
		for (const when of ["before", "after"]) {
			const stop = Error("simulated runner loss");
			await assert.rejects(
				run(async (argv, cwd, options) => {
					const hit = words.every((word) => argv.includes(word));
					if (hit && when === "before") throw stop;
					const result = await nodeExec(argv, cwd, options);
					if (hit && result.code === 0) throw stop;
					return result;
				}),
				(error) => error === stop,
			);
		}
	}
	const result = await run(nodeExec);
	assert.deepEqual(await run(nodeExec), result);
	return result;
}
