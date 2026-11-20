import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	layout,
	nodeExec,
	readPublishable,
	readRepo,
} from "../../src/repo/index.ts";
import { fixture, git, is } from "./fixture.ts";

const protection = {
	reviewedEncode: false,
	allowedChanges: [],
	allowedCandidate: null,
	trunk: null,
} as const;

test("publish and merge compare with both inherited build and trunk, not a sibling's work", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	// A sibling adds a check; the worker takes only that build, not later build changes.
	git(f.root, "switch", f.branch);
	await writeFile(join(f.root, "check-sibling"), "first");
	git(f.root, "add", ".");
	git(f.root, "commit", "-m", "sibling");
	git(f.worker.path, "merge", "--no-edit", f.branch);
	await writeFile(join(f.root, "check-later"), "later");
	git(f.root, "add", ".");
	git(f.root, "commit", "-m", "later sibling");
	git(f.root, "switch", "trunk");
	for (const p of ["check-trunk", "check-edited"])
		await writeFile(join(f.root, p), "trunk");
	git(f.root, "add", ".");
	git(f.root, "commit", "-m", "trunk checks");
	git(f.worker.path, "merge", "--no-edit", "trunk");
	await writeFile(join(f.worker.path, "check-edited"), "worker");
	git(f.worker.path, "commit", "-am", "change inherited check");
	const unsanctioned = await f.publish(["check*"]);
	assert.equal(unsanctioned.kind, "ok");
	assert.ok(unsanctioned.touched.includes("check-trunk"));
	const trunk = (await readRepo(nodeExec, f.root)).trunkHead;
	const pub = await readPublishable(
		nodeExec,
		f.repo,
		f.worker,
		["check*"],
		trunk,
	);
	assert.equal(pub.kind, "ok");
	assert.deepEqual(pub.touched, ["check-edited"]);
	assert.deepEqual(
		pub.changes.map((c) => [c.path, c.kind]),
		[["check-edited", "modified"]],
	);
	assert.equal(
		git(f.root, "diff", "--name-only", pub.base, pub.sha),
		"book\ncheck-edited",
	);
	assert.equal(pub.trunk, git(f.root, "rev-parse", "trunk"));
	// Discover the build tip through a scratch named base, not an unchecked cast.
	git(f.root, "branch", "comparison", f.branch);
	const tip = (await readRepo(nodeExec, f.root, { base: "comparison" }))
		.baseHead;
	const plan = {
		...item,
		expected: tip,
		item: pub.sha,
		protectedGlobs: ["check*"],
		protection: {
			...protection,
			trunk: pub.trunk,
			allowedChanges: pub.changes,
		},
	};
	const merged = await f.run(plan);
	is(merged, "merged");
	assert.deepEqual(merged.protectedChanges, pub.changes);
	assert.deepEqual(merged.touched, ["check-edited"]);
	assert.deepEqual(await f.run(plan), merged);
});

test("merge-only protected deletion holds before proofs or ref movement; only that exact candidate can be allowed", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	git(f.root, "switch", "-c", "encode");
	await writeFile(join(f.root, "guard"), "v2");
	git(f.root, "add", ".");
	git(f.root, "commit", "-m", "encode");
	git(f.worker.path, "merge", "--no-edit", "encode");
	git(f.worker.path, "rm", "guard");
	git(f.worker.path, "commit", "-m", "remove guard");
	const pub = await f.publish(["guard"]);
	assert.equal(pub.kind, "ok");
	assert.deepEqual(pub.touched, []);
	const expected = (await readRepo(nodeExec, f.root, { base: "encode" }))
		.baseHead;
	git(f.root, "update-ref", `refs/heads/${f.branch}`, expected, f.base);
	const plan = {
		...item,
		item: pub.sha,
		expected,
		protectedGlobs: ["guard"],
		protection: {
			...protection,
			trunk: pub.trunk,
			allowedChanges: pub.changes,
		},
	};
	const held = await f.run(plan);
	is(held, "protected");
	assert.deepEqual(
		held.protectedChanges.map((c) => [c.path, c.kind]),
		[["guard", "deleted"]],
	);
	assert.equal(git(f.root, "rev-parse", f.branch), expected);
	assert.ok(!existsSync(plan.integration));
	assert.deepEqual(await f.run(plan), held);
	const changed = {
		...plan,
		message: "different candidate",
		protection: { ...plan.protection, allowedCandidate: held.sha },
	};
	const again = await f.run(changed);
	is(again, "protected");
	assert.notEqual(again.sha, held.sha);
	const authorized = {
		...plan,
		protection: { ...plan.protection, allowedCandidate: held.sha },
	};
	const merged = await f.run(authorized);
	is(merged, "merged");
	assert.equal(merged.sha, held.sha);
	assert.deepEqual(await f.run(authorized), merged);
});

test("rename into a protected glob is not an addition; genuine additions pass, policy files never do", async (t) => {
	const f = await fixture(t);
	const item = await f.item();
	git(
		f.worker.path,
		"restore",
		"--source",
		f.base,
		"--staged",
		"--worktree",
		"--",
		"book",
	);
	git(f.worker.path, "mv", "book", "check-renamed");
	await writeFile(join(f.worker.path, "check-new"), "genuinely new");
	git(f.worker.path, "add", ".");
	git(f.worker.path, "commit", "-m", "rename and add");
	const pub = await f.publish(["check*"]);
	assert.equal(pub.kind, "ok");
	assert.deepEqual(
		pub.changes.map((c) => [c.path, c.kind]),
		[
			["check-new", "added"],
			["check-renamed", "renamed"],
		],
	);
	const { protectedViolations } = await import("../../src/repo/index.ts");
	assert.deepEqual(
		protectedViolations(pub.changes, false).map((c) => c.path),
		["check-renamed"],
	);
	assert.deepEqual(protectedViolations(pub.changes, true), []);
	const encode = await f.run({
		...item,
		item: pub.sha,
		protectedGlobs: ["check*"],
		protection: { ...protection, reviewedEncode: true, trunk: pub.trunk },
	});
	is(encode, "merged");
	await mkdir(join(f.worker.path, ".keel"));
	await writeFile(join(f.worker.path, ".keel", "rule"), "policy");
	git(f.worker.path, "add", ".");
	git(f.worker.path, "commit", "-m", "modify policy");
	const policy = await f.publish([]);
	assert.equal(policy.kind, "ok");
	assert.deepEqual(
		protectedViolations(policy.changes, true).map((c) => c.path),
		[".keel/rule"],
	);
	const plan = {
		...item,
		expected: encode.sha,
		item: policy.sha,
		protectedGlobs: [],
		protection: {
			...protection,
			trunk: policy.trunk,
			reviewedEncode: true,
			allowedChanges: policy.changes,
		},
	};
	const held = await f.run(plan);
	is(held, "protected");
	assert.deepEqual(
		await f.run({
			...plan,
			protection: { ...plan.protection, allowedCandidate: held.sha },
		}),
		held,
	);
	assert.equal(git(f.root, "rev-parse", f.branch), encode.sha);
});

test("a publication waiver does not cover different content at the same protected path", async (t) => {
	const f = await fixture(t);
	const lines = Array.from({ length: 20 }, (_, i) => `line ${i}\n`);
	git(f.root, "switch", "-c", "common");
	await writeFile(join(f.root, "guard"), lines.join(""));
	git(f.root, "add", ".");
	git(f.root, "commit", "-m", "original check");
	const item = await f.item();
	git(f.worker.path, "merge", "--no-edit", "common");
	await writeFile(
		join(f.worker.path, "guard"),
		["worker\n", ...lines.slice(1)].join(""),
	);
	git(f.worker.path, "commit", "-am", "item edit");
	const common = (await readRepo(nodeExec, f.root, { base: "common" }))
		.baseHead;
	git(f.root, "update-ref", `refs/heads/${f.branch}`, common, f.base);
	const pub = await f.publish(["guard"]);
	assert.equal(pub.kind, "ok");
	await writeFile(
		join(f.root, "guard"),
		[...lines.slice(0, -1), "sibling\n"].join(""),
	);
	git(f.root, "commit", "-am", "sibling edit");
	const expected = (await readRepo(nodeExec, f.root, { base: "common" }))
		.baseHead;
	git(f.root, "update-ref", `refs/heads/${f.branch}`, expected, common);
	const plan = {
		...item,
		item: pub.sha,
		expected,
		protectedGlobs: ["guard"],
		protection: { ...protection, allowedChanges: pub.changes },
	};
	const result = await f.run(plan);
	is(result, "protected");
	assert.deepEqual(result.touched, ["guard"]);
	assert.equal(git(f.root, "rev-parse", f.branch), expected);
});

test("a stale start distinguishes a keel landing from a hand-written move to the same commit", async (t) => {
	const f = await fixture(t);
	const op = await f.item();
	const merged = await f.run(op);
	is(merged, "merged");
	const plan = {
		key: "land:42",
		expectedTrunk: f.base,
		combined: merged.sha,
		message: "first landing",
	};
	const target = await f.prepare(plan);
	is(await f.run({ ...plan, kind: "land", target }), "landed");
	const start = {
		...f.start,
		key: "start:43",
		branch: layout.buildBranch("43"),
	};
	assert.deepEqual(await f.run(start), {
		kind: "moved",
		actual: target,
		keelMoved: true,
	});
	git(f.root, "update-ref", "refs/heads/trunk", f.base, target);
	git(f.root, "update-ref", "refs/heads/trunk", target, f.base);
	assert.deepEqual(await f.run(start), { kind: "moved", actual: target });
});
