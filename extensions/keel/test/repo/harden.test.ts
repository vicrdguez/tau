import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { layout, nodeExec, readRepo } from "../../src/repo/index.ts";
import { fixture, git, is } from "./fixture.ts";

test("a proof deadline bounds inherited pipes even outside its group", async (t) => {
	const f = await fixture(t);
	const start = performance.now();
	const results = await Promise.all([false, true].map((wait) =>
		nodeExec([process.execPath, "-e", `
			require('child_process').spawn('sleep', ['3'], {
				detached: true, stdio: ['ignore', 'inherit', 'inherit']
			}).unref();
			${wait ? "setInterval(() => {}, 500)" : ""}
		`], f.root, { env: process.env, timeoutMs: 500 })
	));
	assert.deepEqual(results.map((r) => r.code), [124, 124]);
	assert.ok(performance.now() - start < 2500, "did not stop waiting for leaked pipes");
});

test("a lost proof retries on the candidate, without resetting an attached branch", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const plan = { ...op, checks: [{
		id: "restore", timeoutMs: 5000, argv: ["sh", "-ec",
			'test "$(cat book)" = new; echo scratch > book; git restore book; echo restored']
	}] };
	const stop = Error("runner lost before the proof restored book");
	await assert.rejects(f.run(plan, async (argv, cwd, options) => {
		if (options.timeoutMs) {
			git(cwd, "switch", "trunk");
			await writeFile(join(cwd, "book"), "scratch");
			throw stop;
		}
		return nodeExec(argv, cwd, options);
	}), (e) => e === stop);
	const result = await f.run(plan);
	is(result, "merged");
	assert.match(result.checks[0]!.tail, /restored/);
	assert.equal(git(f.root, "rev-parse", "trunk"), f.base);
	assert.deepEqual(await f.run(plan), result);
});

test("integration reports a protected deletion hidden at publish by an unmerged Encode branch", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	const globs = ["check*"];
	git(f.root, "switch", "-c", "encode", f.base);
	await writeFile(join(f.root, "check.sh"), "v2");
	git(f.root, "add", "check.sh");
	git(f.root, "commit", "-m", "Encode");
	const encode = git(f.root, "rev-parse", "HEAD");
	git(f.worker.path, "merge", "--no-edit", "encode");
	git(f.worker.path, "rm", "check.sh");
	git(f.worker.path, "commit", "-m", "restore old checks");
	const pub = await f.publish(globs);
	assert.equal(pub.kind, "ok");
	assert.deepEqual(pub.touched, []);
	git(f.root, "update-ref", "refs/heads/trunk", encode, f.base);
	const take = {
		kind: "take_trunk", key: "take", integration: layout.integration(f.repo, "42", "take"),
		build: f.branch, expected: f.base, trunk: (await readRepo(nodeExec, f.root)).trunkHead!,
		checks: [], protectedGlobs: globs,
	} as const;
	const combined = await f.run(take);
	is(combined, "combined");
	assert.deepEqual(combined.touched, ["check.sh"]);
	const plan = { ...merge, expected: combined.sha, item: pub.sha, protectedGlobs: globs };
	const result = await f.run(plan);
	is(result, "merged");
	assert.deepEqual(result.touched, ["check.sh"]);
	assert.deepEqual(await f.run(plan), result);
});

test("criss-cross publish conservatively reports changes against every best base", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	git(f.root, "switch", f.branch);
	await writeFile(join(f.root, "check"), "build");
	git(f.root, "add", "check");
	git(f.root, "commit", "-m", "add check");
	const side = git(f.root, "rev-parse", "HEAD");
	git(f.root, "merge", "--no-edit", item.item);
	git(f.worker.path, "merge", "--no-edit", side);
	const result = await f.publish();
	assert.equal(result.kind, "ok");
	assert.deepEqual(result.touched, ["book", "check"]);
	const filtered = await f.publish(["c*"]);
	assert.equal(filtered.kind, "ok");
	assert.deepEqual(filtered.touched, ["check"]);
});

test("a merged head must contain the current worker before ignored outputs may be discarded", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	const nested = join(f.worker.path, "output");
	git(f.worker.path, "init", nested);
	git(nested, "-c", "user.name=test", "-c", "user.email=t@test", "commit", "--allow-empty", "-m", "only copy");
	const onlyCopy = git(nested, "rev-parse", "HEAD");
	await writeFile(join(f.repo.commonDir, "info/exclude"), "output/\n");
	const remove = {kind: "remove", key: "drop", target: f.worker, merged: true} as const;
	is(await f.run({...remove, mergedHead: f.base}), "kept");
	assert.equal(git(nested, "rev-parse", "HEAD"), onlyCopy);
	const merged = await f.run(item);
	is(merged, "merged");
	is(await f.run({...remove, mergedHead: merged.sha}), "removed");
});

test("starts planned without trunk can share only keel's first trunk creation", async (t) => {
	const f = await fixture(t);
	const other = { ...f.start, key: "start:43", branch: layout.buildBranch("43") };
	git(f.root, "branch", "trunk", f.base);
	assert.deepEqual(await f.run(other), {kind:"occupied", path:"refs/heads/trunk"});
	git(f.root, "branch", "-D", "trunk");
	const starts = await Promise.all([f.run(f.start), f.run(other)]);
	for (const s of starts) assert.deepEqual(s, {kind:"started", base:f.base});
	assert.equal(git(f.root, "rev-parse", other.branch), f.base);
	const later = { ...f.start, key: "start:44", branch: layout.buildBranch("44") };
	is(await f.run(later), "started");
});
