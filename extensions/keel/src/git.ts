import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { Plan } from "./work.ts";

const run = promisify(execFile);

/** Git with an argument list, never a shell. Rejects with Git's own message. */
async function git(cwd: string, ...args: string[]) {
	try {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		);
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_CONFIG_GLOBAL = "/dev/null";
		env.GIT_GRAFT_FILE = "/dev/null";
		env.GIT_NO_REPLACE_OBJECTS = "1";
		return (await run("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }))
			.stdout;
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(stderr || String(error));
	}
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commit a ref names, checked to be a SHA that Git produced. */
export async function commitOf(cwd: string, ref: string) {
	const sha = (
		await git(
			cwd,
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${ref}^{commit}`,
		)
	).trim();
	if (!SHA.test(sha)) throw new Error(`Git named no commit for ${ref}.`);
	return sha;
}

/** Look up the registered worktree, not just a directory with a matching HEAD. */
async function registered(repo: string, path: string) {
	const real = realpathSync(path);
	const blocks = (
		await git(repo, "worktree", "list", "--porcelain", "-z")
	).split("\0\0");
	return blocks
		.map((block) => block.split("\0"))
		.find((lines) => lines[0] === `worktree ${real}`);
}

export async function ensureCheckout(
	repo: string,
	path: string,
	sha: string,
): Promise<string | undefined> {
	try {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) {
			await git(repo, "worktree", "add", "--detach", path, sha);
			return;
		}
		const tree = stat.isDirectory() ? await registered(repo, path) : undefined;
		if (
			tree?.includes("detached") &&
			tree.includes(`HEAD ${sha}`) &&
			(
				await git(path, "status", "--porcelain", "--untracked-files=all")
			).trim() === ""
		)
			return;
		return `Expected a clean, detached worktree of ${repo} at ${path} on ${sha}. Keel deleted nothing.`;
	} catch (error) {
		return `Keel could not prepare the verifier checkout at ${path}: ${(error as Error).message}`;
	}
}

/**
 * Row 9: no directory at the path, create the worktree; the planned worktree, carry on; anything else, say what is
 * there. Deletes nothing.
 */
export async function ensureWorktree(plan: Plan): Promise<string | undefined> {
	if (!existsSync(plan.path)) {
		try {
			await git(
				plan.repo,
				"worktree",
				"add",
				"-b",
				plan.branch,
				plan.path,
				plan.baseSha,
			);
			return undefined;
		} catch (error) {
			return `Keel could not create the worktree at ${plan.path}: ${(error as Error).message}`;
		}
	}
	const found = await registered(plan.repo, plan.path);
	if (found === undefined)
		return `${plan.path} exists and is not a worktree of ${plan.repo}. Keel deleted nothing.`;
	if (!found.includes(`branch refs/heads/${plan.branch}`))
		return `The worktree at ${plan.path} is not on branch ${plan.branch}. Keel deleted nothing.`;
	try {
		await git(plan.path, "merge-base", "--is-ancestor", plan.baseSha, "HEAD");
		return undefined;
	} catch {
		return `The worktree at ${plan.path} does not start at ${plan.baseSha}. Keel deleted nothing.`;
	}
}

/** Row 11: the head of the plan's branch in a clean worktree, or why there is none to publish. */
export async function publishedHead(
	plan: Plan,
): Promise<{ sha: string } | { refused: string }> {
	if ((await git(plan.path, "status", "--porcelain")).trim() !== "")
		return {
			refused:
				"The worktree has changes that are not committed. Commit them, then publish.",
		};
	const branch = (
		await git(plan.path, "rev-parse", "--abbrev-ref", "HEAD")
	).trim();
	if (branch !== plan.branch)
		return { refused: `Check out ${plan.branch} before you publish.` };
	return { sha: await commitOf(plan.path, "HEAD") };
}

/** Row 19: where the plan's branch points now. */
export const branchHead = (plan: Plan) =>
	commitOf(plan.repo, `refs/heads/${plan.branch}`);
