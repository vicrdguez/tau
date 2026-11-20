import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: cwd,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	}).trimEnd();
}
export function is<K extends RepoResult["kind"]>(
	result: RepoResult,
	kind: K,
): asserts result is Extract<RepoResult, { kind: K }> {
	assert.equal(result.kind, kind, JSON.stringify(result));
}
export async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "keel repo ")));
	t.after(() => rm(root, { recursive: true, force: true }));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Owner");
	git(root, "config", "user.email", "owner@example.test");
	await writeFile(join(root, "book"), "old\n");
	git(root, "add", ".");
	git(root, "commit", "-m", "original");
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
	const publish = (globs?: readonly string[]) =>
		readPublishable(nodeExec, repo, worker, globs);
	async function prepare(plan: Landing) {
		const result = await run({ ...plan, kind: "prepare_landing" });
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
