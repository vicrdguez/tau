// Create and operate a real temporary Git repository. No Keel Git plans or
// expected results are inferred here; callers own the history they need.
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

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

export async function tempRepo(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "keel repo ")));
	t.after(() => rm(root, { recursive: true, force: true }));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Owner");
	git(root, "config", "user.email", "owner@example.test");
	await writeFile(join(root, "book"), "old\n");
	git(root, "add", ".");
	git(root, "commit", "-m", "original");
	return { root, base: git(root, "rev-parse", "HEAD") };
}
