import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureWorktree, publishedHead } from "../src/git.ts";
import type { Plan } from "../src/work.ts";
import {
	answered,
	approved,
	call,
	commitStep,
	data,
	git,
	named,
	plannedPath,
	repository,
	world,
} from "./setup.ts";

function environment(
	t: import("node:test").TestContext,
	key: string,
	value: string,
) {
	const previous = process.env[key];
	process.env[key] = value;
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
}

function built(t: import("node:test").TestContext) {
	const repo = repository();
	t.after(() => rmSync(join(repo, ".."), { recursive: true, force: true }));
	const baseSha = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "export.js"), "MALICIOUS_PUBLISHED\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "Build");
	const sha = git(repo, "rev-parse", "HEAD");
	const plan: Plan = {
		repo,
		path: repo,
		branch: "main",
		base: "main",
		baseSha,
	};
	return { repo, plan, sha };
}

test("row 11: publish_build reads the real commit even when its type is replaced", async () => {
	const w = await world();
	try {
		w.script(
			"worker",
			commitStep("export.js", "published", "Build"),
			call("bash", {
				command: "git replace -f HEAD $(git rev-parse HEAD:export.js)",
			}),
			call("publish_build", { text: "Built." }),
		);
		const { k } = await approved(w);
		const I = await named(w, "building");
		const builds = await w.entries(I, "keel.build");
		assert.equal(builds.length, 1);
		assert.equal(
			data(builds[0]).sha,
			git(plannedPath(w.repo, k), "--no-replace-objects", "rev-parse", "HEAD"),
		);
	} finally {
		await w.close();
	}
});

for (const variable of [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG_PARAMETERS",
]) {
	test(`Keel Git ignores inherited ${variable}`, async (t) => {
		const { repo, plan, sha } = built(t);

		const value =
			variable === "GIT_DIR"
				? join(repo, "missing")
				: variable === "GIT_CONFIG_PARAMETERS"
					? "'color.diff=always'"
					: join(repo, "missing");
		environment(t, variable, value);

		assert.deepEqual(await publishedHead(plan), { sha });
	});
}

test("row 9: a legacy graft cannot hide the planned base ancestry", async (t) => {
	const { repo, plan, sha } = built(t);
	writeFileSync(join(repo, ".git/info/grafts"), `${sha}\n`);
	assert.equal(await ensureWorktree(plan), undefined);
});

for (const change of ["replace", "graft"] as const) {
	test(`row 19: the hand-over head check ignores a ${change}`, async () => {
		const w = await world();
		try {
			w.script(
				"worker",
				commitStep("export.js", "published", "Build"),
				call("publish_build", { text: "Built." }),
			);
			w.script(
				"verifier",
				call("publish_verdict", {
					text: "Good.",
					verdict: "pass",
					findings: [],
				}),
			);
			const { k, s } = await approved(w);
			await w.open(s.handover(1));
			const path = plannedPath(w.repo, k);
			const sha = git(path, "rev-parse", "HEAD");
			if (change === "replace") {
				const blob = git(path, "rev-parse", "HEAD:export.js");
				git(path, "replace", "-f", sha, blob);
			} else {
				writeFileSync(join(w.repo, ".git/info/grafts"), `${sha}\n`);
			}
			answered(await w.reply(s.handover(1), "approve"));
			await w.settle();
			assert.equal((await w.events()).at(-1)?.stage, "handed_over");
			assert.equal(data((await w.entries(k, "keel.handover"))[0]).sha, sha);
		} finally {
			await w.close();
		}
	});
}
