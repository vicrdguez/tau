import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { layout, nodeExec, readRepo } from "../../src/repo/index.ts";
import { fixture, git, is } from "./fixture.ts";

test("a proof deadline bounds inherited pipes even outside its group", async (t) => {
	const f = await fixture(t);
	const start = performance.now();
	const results = await Promise.all(
		[false, true].map((wait) =>
			nodeExec(
				[
					process.execPath,
					"-e",
					`
			require('child_process').spawn('sleep', ['3'], {
				detached: true, stdio: ['ignore', 'inherit', 'inherit']
			}).unref();
			${wait ? "setInterval(() => {}, 500)" : ""}
		`,
				],
				f.root,
				{ env: process.env, timeoutMs: 500 },
			),
		),
	);
	assert.deepEqual(
		results.map((r) => r.code),
		[124, 124],
	);
	assert.ok(
		performance.now() - start < 2500,
		"did not stop waiting for leaked pipes",
	);
});

test("a lost proof retries on the candidate, without resetting an attached branch", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const plan = {
		...op,
		checks: [
			{
				id: "restore",
				timeoutMs: 5000,
				argv: [
					"sh",
					"-ec",
					'test ! -e proof.tmp; test "$(cat book)" = new; echo scratch > book; git restore book; echo restored',
				],
			},
		],
	};
	const stop = Error("runner lost before the proof restored book");
	await assert.rejects(
		f.run(plan, async (argv, cwd, options) => {
			if (options.timeoutMs) {
				git(cwd, "switch", "trunk");
				await writeFile(join(cwd, "proof.tmp"), "interrupted stage");
				git(cwd, "add", "proof.tmp");
				git(cwd, "update-index", "--skip-worktree", "book");
				await writeFile(join(cwd, "book"), "scratch");
				throw stop;
			}
			return nodeExec(argv, cwd, options);
		}),
		(e) => e === stop,
	);
	const result = await f.run(plan);
	is(result, "merged");
	assert.match(result.checks[0]!.tail, /restored/);
	assert.equal(git(f.root, "rev-parse", "trunk"), f.base);
	assert.deepEqual(await f.run(plan), result);
});

test("criss-cross publish compares against both best build bases", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	const policy = ".keel/principles/check.md";
	git(f.root, "switch", f.branch);
	await mkdir(join(f.root, ".keel/principles"), { recursive: true });
	await writeFile(join(f.root, policy), "build");
	git(f.root, "add", policy);
	git(f.root, "commit", "-m", "add principle on build");
	const side = git(f.root, "rev-parse", "HEAD");
	git(f.root, "merge", "--no-edit", item.item);
	git(f.worker.path, "merge", "--no-edit", side);
	const inherited = await f.publish();
	assert.equal(inherited.kind, "ok");
	assert.equal(
		git(f.root, "diff", "--name-only", inherited.base, inherited.sha),
		"",
	);
	assert.deepEqual(inherited.changedPolicyFiles, []);

	await writeFile(join(f.worker.path, policy), "edited by item");
	git(f.worker.path, "commit", "-am", "revise principle");
	const changed = await f.publish();
	assert.equal(changed.kind, "ok");
	assert.equal(changed.base, inherited.base);
	assert.equal(
		git(f.root, "diff", "--name-only", changed.base, changed.sha),
		policy,
	);
	assert.deepEqual(changed.changedPolicyFiles, [policy]);
});

test("a merged head must contain the current worker before ignored outputs may be discarded", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	const nested = join(f.worker.path, "output");
	git(f.worker.path, "init", nested);
	git(
		nested,
		"-c",
		"user.name=test",
		"-c",
		"user.email=t@test",
		"commit",
		"--allow-empty",
		"-m",
		"only copy",
	);
	const onlyCopy = git(nested, "rev-parse", "HEAD");
	await writeFile(join(f.repo.commonDir, "info/exclude"), "output/\n");
	const remove = {
		kind: "remove",
		key: "drop",
		target: f.worker,
		merged: true,
	} as const;
	is(await f.run({ ...remove, mergedHead: f.base }), "kept");
	assert.equal(git(nested, "rev-parse", "HEAD"), onlyCopy);
	const merged = await f.run(item);
	is(merged, "merged");
	is(await f.run({ ...remove, mergedHead: merged.sha }), "removed");
});

test("starts planned without trunk can share only keel's first trunk creation", async (t) => {
	const f = await fixture(t);
	const other = {
		...f.start,
		key: "start:43",
		branch: layout.buildBranch("43"),
	};
	git(f.root, "branch", "trunk", f.base);
	assert.deepEqual(await f.run(other), {
		kind: "occupied",
		path: "refs/heads/trunk",
	});
	git(f.root, "branch", "-D", "trunk");
	const starts = await Promise.all([f.run(f.start), f.run(other)]);
	for (const s of starts)
		assert.deepEqual(s, { kind: "started", base: f.base });
	assert.equal(git(f.root, "rev-parse", other.branch), f.base);
	const later = {
		...f.start,
		key: "start:44",
		branch: layout.buildBranch("44"),
	};
	is(await f.run(later), "started");
});

test("git inside a proof reads ordinary owner config without keel's graft hint", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const config = join(f.root, "owner.gitconfig");
	git(f.root, "config", "--file", config, "keel.test", "from owner");
	const previous = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = config;
	t.after(() => {
		if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = previous;
	});
	const result = await f.run({
		...op,
		checks: [
			{
				id: "owner git",
				timeoutMs: 5000,
				argv: ["sh", "-ec", "git log -1 --format=; git config --get keel.test"],
			},
		],
	});
	is(result, "merged");
	assert.equal(result.checks[0]!.tail.trim(), "from owner");
});

for (const damage of ["delete", "break gitfile", "attach build"] as const) {
	test(`proof damage: ${damage} fails with candidate and replays without deleting foreign files`, async (t) => {
		const f = await fixture(t);
		const merge = await f.item();
		const script =
			damage === "delete"
				? 'cd .. && rm -rf -- "$1"'
				: damage === "break gitfile"
					? "printf broken > .git"
					: 'git switch "$2"';
		const plan = {
			...merge,
			checks: [
				{
					id: "damage",
					timeoutMs: 5000,
					argv: [
						"sh",
						"-ec",
						"echo proof-output; " + script,
						"proof",
						merge.integration,
						f.branch,
					],
				},
			],
		};
		const result = await f.run(plan);
		is(result, "checks_failed");
		assert.equal(git(f.root, "rev-parse", result.sha + "^2"), merge.item);
		assert.equal(git(f.root, "rev-parse", f.branch), merge.expected);
		assert.equal(result.checks[0]!.code, 0);
		assert.match(result.checks[0]!.tail, /proof-output/);
		assert.deepEqual(await f.run(plan), result);
		const target = {
			kind: "checkout",
			key: merge.key,
			path: merge.integration,
		} as const;
		const remove = { kind: "remove", key: "cleanup", target } as const;
		if (damage === "break gitfile") {
			await writeFile(join(target.path, "keep"), "foreign?");
			is(await f.run(remove), "occupied");
			assert.equal(
				await readFile(join(target.path, "keep"), "utf8"),
				"foreign?",
			);
			return;
		}
		if (damage === "delete") {
			is(
				await f.run({ ...remove, target: { ...target, key: "wrong" } }),
				"occupied",
			);
			await mkdir(target.path);
			await writeFile(join(target.path, "keep"), "foreign");
			is(await f.run(remove), "occupied");
			assert.equal(
				await readFile(join(target.path, "keep"), "utf8"),
				"foreign",
			);
			await rm(target.path, { recursive: true });
		}
		is(await f.run(remove), "removed");
		assert.ok(
			!git(f.root, "worktree", "list", "--porcelain").includes(target.path),
		);
		is(await f.run(remove), "removed");
	});
}
