import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { openNodeSqliteStorage } from "tau/durable";
import { openLiveRevision } from "./fixtures/live-revision.ts";
import { fixture, git } from "./repo/fixture.ts";

const save = (kind: string, text: string) => {
	if (process.env.KEEL_REVIEW_ARTIFACTS)
		writeFileSync(`${process.env.KEEL_REVIEW_ARTIFACTS}-${kind}.md`, text);
};

const child = fileURLToPath(
	new URL("./fixtures/revision-kill.ts", import.meta.url),
);

test("Scenario 3: recover a mid-build Mandate revision after triage and approval, then replan, resume, land and hand over", {
	timeout: 40000,
}, async (t) => {
	const { root, base } = await fixture(t);
	const file = join(root, ".git", "revision.sqlite");
	const open = async (first = false) =>
		openLiveRevision(root, await openNodeSqliteStorage(file), first);
	const kill = async (point: "triage" | "approval") => {
		await assert.rejects(
			promisify(execFile)(process.execPath, [child, root, file, point], {
				timeout: 15000,
			}),
			{ signal: "SIGKILL", stdout: `kill:${point}\n` },
		);
	};
	const first = await open(true);
	const { triageId, old, stats, writer } = await (async () => {
		try {
			await first.openTriage();
			const triage = await first.review("triage/");
			save("triage", triage.text);
			assert.match(triage.text, /The filer could not continue item writer\./);
			assert.doesNotMatch(triage.text, /Held items:|Keeps running:/);
			assert.match(triage.text, /write_book value/);
			assert.doesNotMatch(triage.text, /Reference: Book reader contract/);
			return {
				triageId: (await first.review("triage/")).decision.id,
				old: (await first.desk())?.mandate,
				stats: git(
					root,
					"rev-parse",
					`${first.build.replace(/\/build$/, "")}/item/stats-1`,
				),
				writer: git(
					root,
					"rev-parse",
					`${first.build.replace(/\/build$/, "")}/item/writer-1`,
				),
			};
		} finally {
			first.permitStats();
			await first.harness.close(ctx);
		}
	})();
	assert.ok(old);
	await kill("triage");
	const drafting = await open();
	const revisionId = await (async () => {
		try {
			assert.deepEqual(await drafting.asks(), []);
			assert.equal(
				(await drafting.harness.commit((tx) => decision(tx, triageId), ctx))
					?.status,
				"answered",
			);
			assert.deepEqual((await drafting.desk())?.mandate, old);
			await drafting.propose();
			assert.equal((await drafting.asks()).length, 1);
			const revision = await drafting.review("revision/");
			save("revision", revision.text);
			assert.match(
				revision.text,
				/Changed: caller usage, types and signatures, owner/,
			);
			return revision.decision.id;
		} finally {
			await drafting.harness.close(ctx);
		}
	})();
	await kill("approval");
	const s = await open();
	t.after(() => s.harness.close(ctx));
	assert.deepEqual(await s.asks(), []);
	assert.equal(
		(await s.harness.commit((tx) => decision(tx, revisionId), ctx))?.status,
		"answered",
	);
	assert.deepEqual(
		(await s.desk())?.mandate,
		old,
		"an answered approval is staged, not active",
	);
	const item = (id: string) =>
		`${s.build.replace(/\/build$/, "")}/item/${id}-1`;
	assert.throws(() => git(root, "rev-parse", "--verify", item("frame")));
	await s.finish();
	const current = (await s.desk())?.mandate;
	assert.ok(
		current?.nodes.some(
			(n) =>
				n.label === "wire" &&
				"body" in n &&
				n.body.includes("frame_book prefix value"),
		),
	);
	assert.equal(git(root, "show", "trunk:book"), "record:repaired");
	assert.equal(git(root, "show", "trunk:stats"), "one");
	assert.equal(git(root, "show", "trunk:reader"), "repaired");
	assert.equal(
		git(root, "rev-parse", item("stats")),
		stats,
		"the unrelated merged item was not rewritten",
	);
	git(root, "merge-base", "--is-ancestor", writer, item("writer"));
	git(root, "merge-base", "--is-ancestor", item("frame"), item("writer"));
	assert.equal(
		git(
			root,
			"for-each-ref",
			`refs/heads/${s.build.replace(/\/build$/, "")}/item/legacy-*`,
		),
		"",
	);
	assert.equal(git(root, "rev-parse", "main"), base);
	assert.equal(git(root, "rev-parse", "trunk^"), base);
	assert.equal(
		git(root, "rev-parse", "trunk^{tree}"),
		git(root, "rev-parse", `${s.build}^{tree}`),
	);
	assert.equal(
		git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
		1,
	);
	assert.equal((await s.asks()).length, 1);
	const { text } = await s.review("handover");
	save("handover", text);
	assert.match(
		text,
		/1\. Keep statistics independent\.\n\s+acted_on: First plan keeps an independent statistics check\./,
	);
	assert.match(
		text,
		/2\. Prove framing before resuming the writer\.\n\s+acted_on: Revision plan adds a framing item before the writer\./,
	);
	assert.match(text, /Mandate revisions[\s\S]+wire/);
	assert.match(text, /Finding #1[^\n]*writer seam[\s\S]+applied/i);
	for (const value of [
		git(root, "rev-parse", "trunk"),
		"Framed book, reader and statistics pass together.",
	])
		assert.ok(text.includes(value), value);
	await s.answer("handover", "accept");
	assert.deepEqual(await s.asks(), []);
});
