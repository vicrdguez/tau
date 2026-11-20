import assert from "node:assert/strict";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	type Check,
	converge,
	layout,
	nodeExec,
	readPublishable,
	readRepo,
	type Sha,
} from "../../src/repo/index.ts";
import { fixture, git, interrupted, is } from "./fixture.ts";

test("start pins base through both trunk/build CAS boundaries; worker and verifier survive each creation boundary", async (t) => {
	const f = await fixture(t);
	assert.equal(f.branch, "keel/42/build");
	assert.equal(f.worker.branch, "keel/42/item/book-1");
	git(
		f.root,
		"commit",
		"--allow-empty",
		"-m",
		"owner advances main after planning",
	);
	const main = git(f.root, "rev-parse", "main");
	const started = await interrupted(
		(e) => f.run(f.start, e),
		[
			["update-ref", "refs/heads/trunk"],
			["update-ref", "refs/heads/" + f.branch],
		],
	);
	assert.deepEqual(started, { kind: "started", base: f.base });
	const worker = await interrupted(
		(e) => f.run(f.worker, e),
		[
			["update-ref", "refs/heads/" + f.worker.branch],
			["worktree", "add", f.worker.path],
		],
	);
	is(worker, "worktree");
	assert.equal(worker.base, f.base);
	assert.equal(git(f.worker.path, "branch", "--show-current"), f.worker.branch);
	is(
		await interrupted(
			(e) => f.run(f.checkout, e),
			[["worktree", "add", f.checkout.path]],
		),
		"checkout",
	);
	assert.equal(git(f.checkout.path, "branch", "--show-current"), "");
	assert.equal(git(f.checkout.path, "rev-parse", "HEAD"), f.base);
	assert.equal(git(f.root, "rev-parse", "main"), main);
});
test("an existing trunk is the build base even when the owner's main has advanced", async (t) => {
	const f = await fixture(t);
	git(f.root, "branch", "trunk", f.base);
	git(f.root, "commit", "--allow-empty", "-m", "not yet on trunk");
	const repo = await readRepo(nodeExec, f.root);
	assert.notEqual(repo.baseHead, repo.trunkHead);
	const result = await converge(nodeExec, repo, f.start);
	assert.deepEqual(result, { kind: "started", base: f.base });
	assert.deepEqual(await converge(nodeExec, repo, f.start), result);
	assert.equal(git(f.root, "rev-parse", f.branch), f.base);
});
test("completed build creation survives another work landing before replay", async (t) => {
	const f = await fixture(t);
	const other = await f.item();
	const repo = await readRepo(nodeExec, f.root);
	const start = { ...f.start, key: "start:A", branch: layout.buildBranch("A") };
	const result = await converge(nodeExec, repo, start);
	is(result, "started");
	const plan = {
		key: "B",
		expectedTrunk: f.base,
		combined: other.item,
		message: "land B",
	};
	const target = await f.prepare(plan);
	is(await f.run({ ...plan, kind: "land", target }), "landed");
	assert.deepEqual(await converge(nodeExec, repo, start), result);
	assert.equal(git(f.root, "rev-parse", start.branch), f.base);
	assert.equal(git(f.root, "rev-parse", "trunk"), target);
});
test("completed worker creation survives another item merging before replay", async (t) => {
	const f = await fixture(t);
	const other = await f.item();
	const worker = {
		...f.worker,
		key: "worker:2",
		branch: layout.itemBranch("42", "second", 1),
		path: layout.worktree(f.repo, "42", "second"),
	};
	const result = await f.run(worker);
	is(result, "worktree");
	is(await f.run(other), "merged");
	assert.deepEqual(await f.run(worker), result);
	assert.equal(git(worker.path, "rev-parse", "HEAD"), f.base);
});
test("discovery from a linked checkout uses its toplevel but the shared repository layout", async (t) => {
	const f = await fixture(t);
	const linked = join(f.root, "linked space");
	git(f.root, "worktree", "add", "--detach", linked, "main");
	const again = await readRepo(nodeExec, linked);
	assert.equal(again.root, linked);
	assert.equal(again.commonDir, f.repo.commonDir);
	assert.equal(layout.worktree(again, "42", "worker 1"), f.worker.path);
	is(await converge(nodeExec, again, f.start), "started");
	assert.deepEqual(
		await readRepo(nodeExec, linked),
		await readRepo(nodeExec, linked),
	);
});
test("ref-prefix collisions are occupied, not a reason to delete a ref", async (t) => {
	const f = await fixture(t);
	git(f.root, "branch", "keel/42", f.base);
	is(await f.run(f.start), "occupied");
	assert.equal(git(f.root, "rev-parse", "keel/42"), f.base);
	git(f.root, "branch", "-d", "keel/42");
	git(f.root, "branch", f.branch + "/child", f.base);
	is(await f.run(f.start), "occupied");
	assert.equal(git(f.root, "rev-parse", f.branch + "/child"), f.base);
	assert.equal((await readRepo(nodeExec, f.root)).trunkHead, null);
});
test("a revision alias cannot stand in for an absent trunk branch", async (t) => {
	const f = await fixture(t);
	git(f.root, "tag", "refs/heads/trunk", f.base);
	const repo = await readRepo(nodeExec, f.root);
	assert.equal(repo.trunkHead, null);
	is(await converge(nodeExec, repo, f.start), "started");
	assert.equal(
		git(f.root, "show-ref", "--verify", "--hash", "refs/heads/trunk"),
		f.base,
	);
});
test("trunk equal to base, reserved branch aliases and escaping layout names are refused", async (t) => {
	const f = await fixture(t);
	git(f.root, "branch", "stable", f.base);
	for (const opts of [
		{ base: "main", trunk: "main" },
		{ base: "stable", trunk: "main" },
		{ base: f.branch, trunk: "trunk" },
		{ trunk: "keel/42/trunk" },
		{ trunk: "refs/heads/main" },
		{ trunk: "refs/tags/x" },
		{ trunk: "HEAD" },
	])
		await assert.rejects(readRepo(nodeExec, f.root, opts));
	assert.throws(() => layout.worktree(f.repo, "42", "../outside"));
	assert.throws(() => layout.buildBranch("../main"));
	assert.equal(git(f.root, "rev-parse", "main"), f.base);
});
test("foreign directory (even empty), foreign lock and symlinked parent never earn ownership", async (t) => {
	const f = await fixture(t);
	await mkdir(f.checkout.path, { recursive: true });
	is(await f.run(f.checkout), "occupied");
	await rm(f.checkout.path, { recursive: true });
	git(
		f.root,
		"worktree",
		"add",
		"--detach",
		"--lock",
		"--reason",
		"human",
		f.checkout.path,
		"main",
	);
	is(await f.run(f.checkout), "occupied");
	is(
		await f.run({ kind: "remove", key: "drop", target: f.checkout }),
		"occupied",
	);
	assert.equal(git(f.checkout.path, "rev-parse", "HEAD"), f.base);
	await rename(dirname(f.checkout.path), join(f.root, "outside"));
	await symlink(join(f.root, "outside"), dirname(f.checkout.path));
	is(await f.run(f.checkout), "occupied");
});
test("hand-removed locked checkout (including a replacement directory) is never pruned or force-removed", async (t) => {
	const f = await fixture(t);
	is(await f.run(f.checkout), "checkout");
	await rm(f.checkout.path, { recursive: true });
	const registered = git(f.root, "worktree", "list", "--porcelain");
	is(await f.run(f.checkout), "occupied");
	const remove = { kind: "remove", key: "drop", target: f.checkout } as const;
	is(await f.run(remove), "occupied");
	await mkdir(f.checkout.path);
	await writeFile(join(f.checkout.path, "foreign"), "keep");
	is(await f.run(remove), "occupied");
	assert.equal(
		await readFile(join(f.checkout.path, "foreign"), "utf8"),
		"keep",
	);
	assert.equal(git(f.root, "worktree", "list", "--porcelain"), registered);
});
test("dirty verifier retained on creation replay; forced verifier cleanup converges across removal", async (t) => {
	const f = await fixture(t);
	is(await f.run(f.checkout), "checkout");
	await writeFile(join(f.checkout.path, "book"), "scratch");
	is(await f.run(f.checkout), "occupied");
	assert.equal(
		await readFile(join(f.checkout.path, "book"), "utf8"),
		"scratch",
	);
	const op = { kind: "remove", key: "drop", target: f.checkout } as const;
	is(
		await interrupted(
			(e) => f.run(op, e),
			[["worktree", "remove", f.checkout.path]],
		),
		"removed",
	);
	await assert.rejects(access(f.checkout.path));
});
test("verifier cleanup follows the locked registration even after switching branches", async (t) => {
	const f = await fixture(t);
	is(await f.run(f.checkout), "checkout");
	git(f.checkout.path, "switch", "-c", "comparison");
	git(f.checkout.path, "commit", "--allow-empty", "-m", "verifier notes");
	const tip = git(f.checkout.path, "rev-parse", "HEAD");
	is(
		await f.run({ kind: "remove", key: "drop", target: f.checkout }),
		"removed",
	);
	await assert.rejects(access(f.checkout.path));
	assert.equal(git(f.root, "rev-parse", "comparison"), tip);
});
test("a worker lock is not a disposable verifier lock", async (t) => {
	const f = await fixture(t);
	await f.item();
	await writeFile(join(f.worker.path, "notes"), "keep");
	is(
		await f.run({
			kind: "remove",
			key: "drop",
			target: { ...f.checkout, key: f.worker.key, path: f.worker.path },
		}),
		"occupied",
	);
	assert.equal(await readFile(join(f.worker.path, "notes"), "utf8"), "keep");
});
test("dirty worker (including ignored files) retained at removal; clean worker removal leaves its ref", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	const remove = { kind: "remove", key: "drop", target: f.worker } as const;
	await writeFile(join(f.repo.commonDir, "info/exclude"), "scratch\n");
	await writeFile(join(f.worker.path, "scratch"), "work");
	is(await f.run(remove), "kept");
	is(await f.run(merge), "merged");
	await writeFile(join(f.worker.path, "notes"), "keep");
	const kept = await f.run({ ...remove, merged: true });
	is(kept, "kept");
	assert.deepEqual(kept.files, ["notes"]);
	assert.equal(await readFile(join(f.worker.path, "notes"), "utf8"), "keep");
	await rm(join(f.worker.path, "notes"));
	is(
		await interrupted(
			(e) => f.run({ ...remove, merged: true }, e),
			[["worktree", "remove", f.worker.path]],
		),
		"removed",
	);
	await assert.rejects(access(f.worker.path));
	assert.equal(git(f.root, "rev-parse", f.worker.branch), merge.item);
});
test("a worker's index cannot hide local edits at publish or forced removal", async (t) => {
	const f = await fixture(t);
	await f.item();
	const file = join(f.worker.path, "book");
	await writeFile(file, "keep my edits");
	for (const flag of ["assume-unchanged", "skip-worktree"]) {
		git(f.worker.path, "update-index", "--" + flag, "book");
		assert.equal((await f.publish()).kind, "dirty");
		is(await f.run({ kind: "remove", key: "drop", target: f.worker }), "kept");
		assert.equal(await readFile(file, "utf8"), "keep my edits");
		git(f.worker.path, "update-index", "--no-" + flag, "book");
	}
});
test("worker removal does not discard private files inside a checked-out submodule", async (t) => {
	const f = await fixture(t);
	await f.item();
	const dep = join(f.worker.path, "dep");
	git(
		f.worker.path,
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		"-b",
		"main",
		f.root,
		"dep",
	);
	git(f.worker.path, "commit", "-m", "add submodule");
	await writeFile(
		git(
			dep,
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"info/exclude",
		),
		"private\n",
	);
	await writeFile(join(dep, "private"), "keep");
	const kept = await f.run({
		kind: "remove",
		key: "drop",
		target: f.worker,
		merged: true,
	});
	is(kept, "kept");
	assert.deepEqual(kept.files, ["dep"]);
	assert.equal(await readFile(join(dep, "private"), "utf8"), "keep");
});
test("worker creation refuses a pre-existing item branch checked out elsewhere, even at the planned base", async (t) => {
	const f = await fixture(t);
	is(await f.run(f.start), "started");
	const other = join(f.root, "foreign worker");
	git(f.root, "worktree", "add", "-b", f.worker.branch, other, f.base);
	is(await f.run(f.worker), "occupied");
	assert.equal(git(other, "branch", "--show-current"), f.worker.branch);
	await assert.rejects(access(f.worker.path));
});
test("substituting another worktree's gitfile cannot authorize deleting the registered path", async (t) => {
	const f = await fixture(t);
	is(await f.run(f.checkout), "checkout");
	const other = join(f.root, "foreign verifier");
	git(f.root, "worktree", "add", "--detach", other, f.base);
	await writeFile(
		join(f.checkout.path, ".git"),
		await readFile(join(other, ".git")),
	);
	await writeFile(join(f.checkout.path, "foreign"), "keep");
	is(
		await f.run({ kind: "remove", key: "drop", target: f.checkout }),
		"occupied",
	);
	assert.equal(
		await readFile(join(f.checkout.path, "foreign"), "utf8"),
		"keep",
	);
	assert.equal(git(other, "rev-parse", "HEAD"), f.base);
});
test("moved build, item or pinned trunk is reported, never rewound", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	is(await f.run(f.worker), "moved");
	git(f.root, "update-ref", "refs/heads/" + f.branch, merge.item);
	is(await f.run(f.start), "moved");
	is(await f.run(merge), "moved");
	git(f.root, "update-ref", "refs/heads/trunk", merge.item);
	is(await f.run({ ...f.start, branch: layout.buildBranch("43") }), "moved");
	for (const ref of [f.branch, f.worker.branch, "trunk"])
		assert.equal(git(f.root, "rev-parse", ref), merge.item);
});
test("a foreign branch at exactly the planned tip is not an interrupted keel creation", async (t) => {
	const f = await fixture(t);
	git(f.root, "branch", f.branch, f.base);
	is(await f.run(f.start), "occupied");
	git(f.root, "branch", "-d", f.branch);
	is(await f.run(f.start), "started");
	git(f.root, "branch", f.worker.branch, f.base);
	is(await f.run(f.worker), "occupied");
	await assert.rejects(access(f.worker.path));
});
test("a recreated build ref at the expected head is not keel's to advance", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	git(f.root, "branch", "-D", f.branch);
	git(f.root, "branch", f.branch, op.expected);
	is(await f.run(op), "occupied");
	assert.equal(git(f.root, "rev-parse", f.branch), op.expected);
	await assert.rejects(access(op.integration));
});
test("a worker lock does not authorize publishing a replacement item ref", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	git(f.root, "update-ref", "-d", "refs/heads/" + f.worker.branch);
	git(f.root, "update-ref", "refs/heads/" + f.worker.branch, op.item);
	assert.equal((await f.publish()).kind, "occupied");
	assert.equal(git(f.worker.path, "rev-parse", "HEAD"), op.item);
});
test("landing cannot advance trunk underneath a worktree rebasing it", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const other = join(f.root, "in rebase");
	git(f.root, "worktree", "add", other, "trunk");
	await writeFile(join(other, "book"), "trunk\n");
	git(other, "commit", "-am", "on trunk");
	const trunk = (await readRepo(nodeExec, f.root)).trunkHead!;
	assert.throws(() => git(other, "rebase", op.item));
	assert.equal(git(other, "branch", "--show-current"), "");
	git(f.root, "switch", "-c", "candidate", trunk);
	await writeFile(join(f.root, "book"), "combined");
	git(f.root, "commit", "-am", "combined");
	const combined = (await readRepo(nodeExec, f.root, { base: "candidate" }))
		.baseHead;
	const p = {
		key: "land",
		expectedTrunk: trunk,
		combined,
		message: "squash",
	};
	const target = await f.prepare(p);
	is(await f.run({ ...p, kind: "land", target }), "occupied");
	assert.equal(git(f.root, "rev-parse", "trunk"), trunk);
});
test("a foreign checkout of the build or trunk prevents CAS even at the expected commit", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	const other = join(f.root, "other");
	git(f.root, "worktree", "add", other, f.branch);
	is(await f.run(merge), "occupied");
	git(other, "switch", "trunk");
	const plan = {
		key: "land",
		expectedTrunk: f.base,
		combined: merge.item,
		message: "land",
	};
	const sha = await f.prepare(plan);
	is(await f.run({ kind: "land", ...plan, target: sha }), "occupied");
	assert.equal(git(other, "rev-parse", "HEAD"), f.base);
});
test("symbolic trunk cannot redirect a landing to main", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	const plan = {
		key: "land",
		expectedTrunk: f.base,
		combined: merge.item,
		message: "land",
	};
	const target = await f.prepare(plan);
	git(f.root, "symbolic-ref", "refs/heads/trunk", "refs/heads/main");
	is(await f.run({ kind: "land", ...plan, target }), "occupied");
	assert.equal(git(f.root, "rev-parse", "main"), f.base);
	assert.equal(
		git(f.root, "symbolic-ref", "refs/heads/trunk"),
		"refs/heads/main",
	);
});
test("publish rejects dirt, detachment, and unrelated history; reports both ends of a rename with spaces", async (t) => {
	const f = await fixture(t);
	await f.item();
	await rename(join(f.worker.path, "book"), join(f.worker.path, "new book"));
	assert.equal((await f.publish()).kind, "dirty");
	git(f.worker.path, "add", "-A");
	git(f.worker.path, "commit", "-m", "rename");
	const result = await f.publish();
	assert.deepEqual(result, {
		kind: "ok",
		sha: git(f.worker.path, "rev-parse", "HEAD"),
		touched: ["book", "new book"],
	});
	assert.deepEqual(await f.publish(), result);
	const protectedOnly = await f.publish(["new *"]);
	assert.equal(protectedOnly.kind, "ok");
	assert.deepEqual(protectedOnly.touched, ["new book"]);
	git(f.worker.path, "switch", "--detach");
	assert.equal((await f.publish()).kind, "occupied");
	git(f.worker.path, "switch", f.worker.branch);
	const unrelated = git(
		f.root,
		"commit-tree",
		f.base + "^{tree}",
		"-m",
		"orphan",
	);
	git(f.worker.path, "reset", "--hard", unrelated);
	assert.equal((await f.publish()).kind, "not_descendant");
});
test("publish reports a worker's protected deletion, not the Encode change it merged from build", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	const encode = {
		...f.worker,
		key: "encode",
		branch: layout.itemBranch("42", "encode", 1),
		path: layout.worktree(f.repo, "42", "encode"),
	};
	is(await f.run(encode), "worktree");
	await mkdir(join(encode.path, "tests"));
	await writeFile(join(encode.path, "tests/check.sh"), "check");
	git(encode.path, "add", "tests");
	git(encode.path, "commit", "-m", "Encode adds a check");
	const pub = await readPublishable(nodeExec, f.repo, encode);
	assert.equal(pub.kind, "ok");
	const merged = await f.run({ ...item, item: pub.sha });
	is(merged, "merged");
	git(f.worker.path, "merge", "--no-edit", f.branch);
	const unchanged = await f.publish(["tests/**"]);
	assert.equal(unchanged.kind, "ok");
	git(f.worker.path, "rm", "tests/check.sh");
	git(f.worker.path, "commit", "-m", "remove the check");
	const deleted = await f.publish(["tests/**"]);
	assert.equal(deleted.kind, "ok");
	assert.deepEqual(
		[unchanged.touched, deleted.touched],
		[[], ["tests/check.sh"]],
	);
});
test("git ignores inherited redirection/config, replacement refs and a graft at publish", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	const graft = join(f.repo.commonDir, "info/grafts");
	git(f.root, "replace", merge.item, f.base);
	await writeFile(graft, merge.item + "\n");
	const poison = Object.fromEntries(
		[
			"GIT_DIR",
			"GIT_COMMON_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_CONFIG_PARAMETERS",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_SYSTEM",
			"GIT_NAMESPACE",
			"GIT_SHALLOW_FILE",
			"GIT_GRAFT_FILE",
			"GIT_REPLACE_REF_BASE",
			"GIT_CEILING_DIRECTORIES",
			"GIT_EXEC_PATH",
			"GIT_LITERAL_PATHSPECS",
		].map((k) => [k, "/no such repository"]),
	);
	const before = { ...process.env };
	try {
		Object.assign(process.env, poison);
		assert.deepEqual(await f.publish(["b*"]), {
			kind: "ok",
			sha: merge.item,
			touched: ["book"],
		});
		assert.equal(
			(await readRepo(nodeExec, f.root)).commonDir,
			f.repo.commonDir,
		);
	} finally {
		for (const k of Object.keys(poison)) {
			if (before[k] === undefined) delete process.env[k];
			else process.env[k] = before[k];
		}
	}
});
test("merge and take-trunk survive integration creation and build CAS on both sides, without repeating completed proof", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	async function prove(key: string, file: string) {
		const log = join(f.root, key);
		const checks: Check[] = [
			{
				id: "proof",
				timeoutMs: 5000,
				argv: [
					process.execPath,
					"-e",
					"const fs=require('fs');if(fs.readFileSync(process.argv[1],'utf8')!=='new\\n')process.exit(3);fs.appendFileSync(process.argv[2],'once');console.log('proved')",
					file,
					log,
				],
			},
		];
		return { checks, log };
	}
	const proof = await prove("item.log", "book");
	const op = { ...merge, checks: proof.checks };
	const merged = await interrupted(
		(e) => f.run(op, e),
		[
			["worktree", "add", op.integration],
			["update-ref", "refs/heads/" + f.branch],
		],
	);
	is(merged, "merged");
	assert.equal(await readFile(proof.log, "utf8"), "once");
	assert.match(merged.checks[0]!.tail, /proved/);
	assert.equal(git(f.root, "rev-parse", f.branch), merged.sha);
	assert.equal(git(f.root, "rev-parse", merged.sha + "^2"), merge.item);
	const take = {
		kind: "take_trunk",
		key: "take:1",
		integration: layout.integration(f.repo, "42", "take:1"),
		build: f.branch,
		expected: merged.sha,
		trunk: f.base,
		checks: [],
	} as const;
	const same = await f.run(take);
	is(same, "combined");
	assert.equal(same.sha, merged.sha);
	assert.deepEqual(await f.run(take), same);
	git(f.root, "switch", "trunk");
	await writeFile(join(f.root, "tick"), "new\n");
	git(f.root, "add", "tick");
	git(f.root, "commit", "-m", "another landing");
	git(f.root, "switch", "main");
	const trunk = (await readRepo(nodeExec, f.root)).trunkHead!;
	const other = await prove("take.log", "tick");
	const combine = {
		...take,
		key: "take:2",
		integration: layout.integration(f.repo, "42", "take:2"),
		trunk,
		checks: other.checks,
	};
	const combined = await interrupted(
		(e) => f.run(combine, e),
		[
			["worktree", "add", combine.integration],
			["update-ref", "refs/heads/" + f.branch],
		],
	);
	is(combined, "combined");
	assert.equal(combined.trunk, trunk);
	assert.equal(git(f.root, "show", combined.sha + ":book"), "new");
	assert.equal(git(f.root, "show", combined.sha + ":tick"), "new");
	git(f.root, "update-ref", "refs/heads/trunk", combined.sha, trunk);
	assert.deepEqual(await f.run(combine), combined);
	assert.equal(await readFile(other.log, "utf8"), "once");
});
test("conflict reports the path, and creates no conflict state on the build branch", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	git(f.root, "switch", f.branch);
	await writeFile(join(f.root, "book"), "conflicting\n");
	git(f.root, "commit", "-am", "conflict");
	git(f.root, "switch", "main");
	// Discover the current build commit through git, not through a hash constructor.
	git(f.root, "branch", "inspection", f.branch);
	const expected = (await readRepo(nodeExec, f.root, { base: "inspection" }))
		.baseHead;
	const result = await f.run({ ...op, expected });
	assert.deepEqual(await f.run({ ...op, expected }), result);
	is(result, "conflict");
	assert.deepEqual(result.paths, ["book"]);
	const target = {
		kind: "checkout",
		key: op.key,
		path: op.integration,
	} as const;
	is(await f.run({ kind: "remove", key: "drop", target }), "removed");
	await assert.rejects(access(op.integration));
	assert.equal(git(f.root, "rev-parse", f.branch), expected);
});
test("proof exit terminates children holding the output pipe, pass or fail", async (t) => {
	const f = await fixture(t);
	const results = await Promise.all(
		[0, 7].map((code) =>
			nodeExec(["sh", "-c", `sleep 10 & exit ${code}`], f.root, {
				env: { PATH: process.env.PATH },
				timeoutMs: 1000,
			}),
		),
	);
	assert.deepEqual(
		results.map((r) => r.code),
		[0, 7],
	);
});
test("a stored Mandate check without its timeout cannot run", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const checks = JSON.parse('[{"id":"no-timeout","argv":["touch","ran"]}]');
	await assert.rejects(f.run({ ...op, checks }), /invalid Mandate check/);
	await assert.rejects(access(join(op.integration, "ran")));
	assert.equal(git(f.root, "rev-parse", f.branch), f.base);
});
for (const [name, script] of [
	["failed", "console.error('bad book');process.exit(7)"],
	["hanging", "setInterval(()=>{},1000)"],
] as const) {
	test(
		name + " proof returns a check report, without advancing build",
		async (t) => {
			const f = await fixture(t);
			const op = await f.item();
			const plan = {
				...op,
				checks: [
					{ id: "run", argv: [process.execPath, "-e", script], timeoutMs: 500 },
				],
			};
			const result = await f.run(plan);
			assert.deepEqual(await f.run(plan), result);
			is(result, "checks_failed");
			assert.equal(result.checks[0]!.id, "run");
			assert.notEqual(result.checks[0]!.code, 0);
			if (name === "failed") assert.match(result.checks[0]!.tail, /bad book/);
			assert.equal(git(f.root, "rev-parse", f.branch), f.base);
		},
	);
}
for (const [name, script, paths, headChanged] of [
	["tracked edit", "echo different > book", ["book"], false],
	[
		"moved HEAD",
		"echo different > book && git commit -am changed",
		["book"],
		true,
	],
	["empty proof commit", "git commit --allow-empty -m moved", [], true],
] as const) {
	test(`${name} fails proof with candidate and paths, on first run and replay`, async (t) => {
		const f = await fixture(t);
		const op = await f.item();
		const plan = {
			...op,
			checks: [{ id: "mutates", argv: ["sh", "-c", script], timeoutMs: 5000 }],
		};
		const result = await f.run(plan);
		is(result, "checks_failed");
		assert.deepEqual(result.changes, { paths, headChanged });
		assert.equal(result.checks[0]?.code, 0);
		assert.equal(git(f.root, "rev-parse", `${result.sha}^2`), op.item);
		assert.equal(git(f.root, "show", `${result.sha}:book`), "new");
		assert.deepEqual(await f.run(plan), result);
		assert.equal(git(f.root, "rev-parse", f.branch), f.base);
		is(
			await f.run({
				kind: "remove",
				key: "drop",
				target: {
					kind: "checkout",
					key: op.key,
					path: op.integration,
					sha: result.sha,
				},
			}),
			"removed",
		);
		await assert.rejects(access(op.integration));
	});
}
test("untracked proof output does not change the candidate or prevent replay and cleanup", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const plan = {
		...op,
		checks: [
			{
				id: "build",
				argv: ["sh", "-c", "mkdir -p target && echo ok > target/out"],
				timeoutMs: 5000,
			},
		],
	};
	const result = await f.run(plan);
	is(result, "merged");
	assert.deepEqual(await f.run(plan), result);
	assert.equal(git(f.root, "rev-parse", f.branch), result.sha);
	is(
		await f.run({
			kind: "remove",
			key: "drop",
			target: {
				kind: "checkout",
				key: op.key,
				path: op.integration,
				sha: result.sha,
			},
		}),
		"removed",
	);
	await assert.rejects(access(op.integration));
});
test("project principle and verifier playbook bytes come from the planned commit, not an external symlink", async (t) => {
	const f = await fixture(t);
	const paths = [".keel/principles/risk.md", ".keel/playbooks/verify.md"];
	for (const p of paths) {
		await mkdir(join(f.root, dirname(p)), { recursive: true });
		await writeFile(join(f.root, p), "# " + p + "\n");
	}
	await symlink("/etc/passwd", join(f.root, ".keel/principles/outside.md"));
	git(f.root, "add", ".keel");
	git(f.root, "commit", "-m", "owner prose");
	const repo = await readRepo(nodeExec, f.root);
	is(await converge(nodeExec, repo, f.start), "started");
	const w = await converge(nodeExec, repo, {
		...f.worker,
		base: repo.baseHead,
	});
	is(w, "worktree");
	assert.deepEqual(w.principles, [
		{ name: "risk", body: "# .keel/principles/risk.md\n" },
	]);
	const c = await converge(nodeExec, repo, {
		...f.checkout,
		sha: repo.baseHead,
	});
	is(c, "checkout");
	assert.equal(c.playbook, "# .keel/playbooks/verify.md\n");
});
test("landing prepares the exact reviewable commit then survives a lost CAS result, with no witness ref", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	const plan = {
		key: "landing:42",
		expectedTrunk: f.base,
		combined: merge.item,
		message: "land the book",
	};
	const target = await f.prepare(plan);
	assert.equal(await f.prepare(plan), target);
	assert.equal(git(f.root, "show", "-s", "--format=%P", target), f.base);
	assert.equal(
		git(f.root, "rev-parse", target + "^{tree}"),
		git(f.root, "rev-parse", merge.item + "^{tree}"),
	);
	assert.match(
		git(f.root, "show", "-s", "--format=%B", target),
		/Keel-Effect: landing:42/,
	);
	const refs = git(f.root, "for-each-ref", "--format=%(refname)");
	const result = await interrupted(
		(e) => f.run({ ...plan, kind: "land", target }, e),
		[["update-ref", "refs/heads/trunk"]],
	);
	assert.deepEqual(result, { kind: "landed", sha: target });
	assert.equal(git(f.root, "rev-parse", "trunk"), target);
	assert.equal(git(f.root, "for-each-ref", "--format=%(refname)"), refs);
	assert.equal(git(f.root, "rev-parse", "main"), f.base);
});
test("an identical tree needs no landing, but only while trunk is still at the expected commit", async (t) => {
	const f = await fixture(t);
	is(await f.run(f.start), "started");
	git(
		f.root,
		"commit",
		"--allow-empty",
		"-m",
		"distinct commit, identical tree",
	);
	const combined = (await readRepo(nodeExec, f.root)).baseHead;
	assert.notEqual(combined, f.base);
	const plan = {
		kind: "prepare_landing",
		key: "prepare:same",
		landing: { key: "same", expectedTrunk: f.base, combined, message: "empty" },
	} as const;
	assert.deepEqual(await f.run(plan), { kind: "unchanged", sha: f.base });
	assert.equal(git(f.root, "rev-parse", "trunk"), f.base);
	git(f.root, "update-ref", "refs/heads/trunk", combined, f.base);
	assert.deepEqual(await f.run(plan), { kind: "moved", actual: combined });
});
test("competing landings have one winner; even a same-key trailer on the wrong tree is moved", async (t) => {
	const f = await fixture(t);
	const merge = await f.item();
	async function plan(key: string, combined: Sha) {
		const p = { key, expectedTrunk: f.base, combined, message: "land" };
		return {
			...p,
			kind: "land" as const,
			target: await f.prepare(p),
		};
	}
	const a = await plan("A", merge.item),
		b = await plan("B", merge.item);
	const results = await Promise.all([f.run(a), f.run(b)]);
	assert.deepEqual(results.map((r) => r.kind).sort(), ["landed", "moved"]);
	const impostor = git(
		f.root,
		"commit-tree",
		f.base + "^{tree}",
		"-p",
		f.base,
		"-m",
		"land\n\nKeel-Effect: A",
	);
	git(f.root, "update-ref", "refs/heads/trunk", impostor);
	const moved = await f.run(a);
	is(moved, "moved");
	assert.equal(moved.actual, impostor);
	assert.equal(git(f.root, "rev-parse", "trunk"), impostor);
});
