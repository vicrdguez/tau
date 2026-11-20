import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { MemoryStorage, openNodeSqliteStorage } from "tau/durable";
import { openScenario } from "./fixtures/scenario.ts";
import { fixture, git } from "./repo/fixture.ts";

const child = fileURLToPath(
	new URL("./fixtures/scenario-kill.ts", import.meta.url),
);

async function assertLanded(
	root: string,
	base: string,
	build: string,
	checkouts: string[],
) {
	const trunk = git(root, "rev-parse", "trunk");
	assert.notEqual(trunk, base);
	assert.equal(git(root, "rev-parse", "main"), base);
	assert.equal(
		git(root, "log", "-1", "--format=%P", "trunk"),
		base,
		"landing has only the original trunk as parent",
	);
	assert.equal(
		git(root, "rev-parse", "trunk^{tree}"),
		git(root, "rev-parse", `${build}^{tree}`),
	);
	assert.equal(git(root, "show", "trunk:book"), "repaired");
	assert.equal(
		await readFile(join(root, ".git", "merge-proof"), "utf8"),
		`${git(root, "rev-parse", build)}\n`,
		"the Mandate proof ran on the merge candidate",
	);
	assert.doesNotMatch(
		git(root, "worktree", "list", "--porcelain"),
		/^detached$/m,
		"no verifier or integration checkout remains",
	);
	for (const path of checkouts)
		await assert.rejects(access(path), { code: "ENOENT" });
	return trunk;
}

test("precedent-following bug: one worker addresses a failed verdict, merge proof and full-set verification precede one accepted landing", async (t) => {
	const { root, base } = await fixture(t);
	const s = await openScenario(root, new MemoryStorage(), "rework");
	t.after(() => s.store.harness.close(ctx));
	await s.start();
	await s.settle();
	const checkouts = await s.assertHistory({
		publishes: 2,
		reviews: 3,
		landings: 1,
	});
	const trunk = await assertLanded(
		root,
		base,
		`keel/${s.root.id}/build`,
		checkouts,
	);
	await s.accept(trunk);
});

test("SQLite SIGKILL before first verifier and after trunk CAS: one durable publication, one review per scope, one landing and hand-over", async (t) => {
	const { root, base } = await fixture(t);
	const file = join(root, ".git", "keel.sqlite");
	async function killed(point: "publication" | "landing") {
		await assert.rejects(
			promisify(execFile)(process.execPath, [child, root, file, point], {
				timeout: 30_000,
			}),
			{ signal: "SIGKILL", stdout: `kill:${point}\n` },
		);
	}
	await killed("publication");
	assert.equal(git(root, "rev-parse", "trunk"), base);
	await killed("landing");
	const landedBeforeAck = git(root, "rev-parse", "trunk");
	assert.notEqual(landedBeforeAck, base);
	const logBeforeAck = git(root, "reflog", "show", "trunk", "--format=%H");
	const s = await openScenario(
		root,
		await openNodeSqliteStorage(file),
		"after-landing",
	);
	t.after(() => s.store.harness.close(ctx));
	await s.assertHistory({ publishes: 1, reviews: 2, landings: 1 });
	await s.settle();
	const checkouts = await s.assertHistory({
		publishes: 1,
		reviews: 2,
		landings: 1,
	});
	assert.equal(
		await assertLanded(root, base, `keel/${s.root.id}/build`, checkouts),
		landedBeforeAck,
	);
	assert.equal(
		git(root, "reflog", "show", "trunk", "--format=%H"),
		logBeforeAck,
		"no second trunk write",
	);
	assert.equal(
		s.provider.state.callCount,
		0,
		"the durable landing owed no second agent turn",
	);
	await s.accept(landedBeforeAck);
});
