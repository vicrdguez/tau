import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decision, eventLog } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	type JsonObject,
	MemoryStorage,
	openNodeSqliteStorage,
} from "tau/durable";
import { fauxAnswer, fauxAssistantMessage, fauxToolCall } from "tau/testing";
import { ProjectState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { runRepoEffect } from "../src/workflow.ts";
import { openReview, seedBookPolicy } from "./fixtures/mandate-scenario.ts";
import { openScenario } from "./fixtures/scenario.ts";
import { fixture, git } from "./repo/fixture.ts";
import { latch } from "./toy.ts";

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

test("precedent-setting work: two explorers, two candidates, judge and challenge, two annotation rounds, then land three dependent items", async (t) => {
	const { root } = await fixture(t);
	const base = await seedBookPolicy(root);
	const s = await openReview(root, new MemoryStorage(), true);
	t.after(() => s.harness.close(ctx));
	await s.start();
	s.scriptRevision();
	await s.rework();
	await s.reworkRider();
	await s.approveAndBuild();
	await s.explorePreviousWork();
	await assertLanded(root, base, `keel/${s.root.id}/build`, []);
	assert.match(git(root, "show", "trunk:book-report.sh"), /read_book book/);
});

test("declining the completed arena leaves six settled children and no build or open decisions", {
	timeout: 5000,
}, async (t) => {
	const { root } = await fixture(t);
	await seedBookPolicy(root);
	const s = await openReview(root, new MemoryStorage(), true);
	t.after(() => s.harness.close(ctx));
	await s.start();
	await s.decline();
	assert.deepEqual(await s.subjects(), []);
	assert.deepEqual((await s.harness.inspect(ctx)).tasks, []);
	const owners = await s.harness.commit(async (tx) => {
		const { items } = await tx.scanConversations({}, 100);
		return Promise.all(
			items.flatMap(({ owner }) => (owner ? [tx.task(owner.taskId)] : [])),
		);
	}, ctx);
	assert.equal(owners.length, 6);
	assert.ok(owners.every((owner) => owner?.state.status === "terminal"));
	assert.equal(git(root, "for-each-ref", "refs/heads/keel/"), "");
});

test("SQLite SIGKILL after rework commits: recover the owed revision exactly once with its annotations, without reopening the answered round or starting a build", async (t) => {
	const { root } = await fixture(t);
	await seedBookPolicy(root);
	const file = join(root, ".git", "keel.sqlite");
	const first = await openReview(root, await openNodeSqliteStorage(file), true);
	const review = await (async () => {
		try {
			await first.start();
			return await first.review("mandate/1");
		} finally {
			await first.harness.close(ctx);
		}
	})();
	const kill = fileURLToPath(
		new URL("./fixtures/mandate-kill.ts", import.meta.url),
	);
	await assert.rejects(
		promisify(execFile)(process.execPath, [kill, root, file], {
			timeout: 30000,
		}),
		{ signal: "SIGKILL", stdout: "kill:revision-owed\n" },
	);
	const s = await openReview(root, await openNodeSqliteStorage(file), false);
	t.after(() => s.harness.close(ctx));
	assert.deepEqual(
		await s.subjects(),
		[],
		"old round withdrawn and no new review yet",
	);
	const stored = await s.harness.commit(
		(tx) => decision(tx, review.decision.id),
		ctx,
	);
	assert.ok(stored?.status === "answered");
	assert.equal(stored.choice, "rework");
	assert.deepEqual(
		stored.annotations.map((n) => n.text),
		["Name the future reader.", "Choose the current guide explicitly."],
	);
	s.scriptRevision();
	await s.settle();
	assert.deepEqual(await s.subjects(), ["mandate/2"]);
	const text = (await s.review("mandate/2")).text;
	assert.ok(text.includes("The reporting CLI."));
	const results = (await s.root.entries({}, 100, undefined, ctx)).items
		.flatMap((e) => e.model ?? [])
		.filter((m) => m.role === "toolResult" && m.toolName === "publish_mandate");
	assert.equal(results.length, 2, "exactly one publication in each round");
	assert.equal(git(root, "for-each-ref", "refs/heads/keel/"), "");
});

test("cancel from the idle designer desk while a worker creation is running: one decision, one final inventory, no abort of the desk", {
	timeout: 15000,
}, async (t) => {
	const { root } = await fixture(t);
	const materialized = latch<string>();
	const release = latch<void>();
	const s = await openScenario(
		root,
		new MemoryStorage(),
		"through-publish",
		async (input, ctx, owner) => {
			const result = await runRepoEffect(input, ctx, owner);
			const op = input.spec.op as JsonObject | undefined;
			if (op?.kind === "worktree" && result.kind === "worktree") {
				materialized.resolve(String(op.path));
				await release.promise;
			}
			return result;
		},
	);
	const { harness } = s.store;
	t.after(async () => {
		release.resolve();
		await harness.close(ctx);
	});
	harness.resume();
	await s.start();
	const path = await materialized.promise;
	await writeFile(join(path, "owner-draft"), "Do not discard this");
	s.provider.setResponses([
		fauxAssistantMessage([fauxToolCall("request_cancel", {})], {
			stopReason: "toolUse",
		}),
	]);
	await (
		await s.root.submit(
			{ type: "input", content: "Cancel this work, please." },
			ctx,
		)
	).wait(ctx);
	const slots = Object.values(
		(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
	);
	assert.equal(slots.length, 1);
	const ask = await harness.commit(
		(tx) => decision(tx, slots[0]!.decision),
		ctx,
	);
	assert.ok(ask?.status === "open");
	assert.deepEqual(ask.choices, ["cancel", "continue"]);
	const result = await fauxAnswer(s.store, ask.id, {
		basis: ask.basis,
		choice: "cancel",
		annotations: [],
	});
	assert.equal(result.kind, "answered");
	const answer = (
		await harness.commit((tx) => tx.scanTasks({ kind: "keel.answer" }, 10), ctx)
	).items[0];
	assert.ok(answer);
	await harness.waitForTask(answer.id, ctx);
	release.resolve();
	await s.settle();
	const events = await harness.commit(
		async (tx) => tx.scanEntries({ conversationId: await eventLog(tx) }, 100),
		ctx,
	);
	const inventory = events.items
		.filter((e) => e.kind === "keel.event")
		.map((e) => String((e.data as JsonObject).text))
		.filter((text) => text.includes("Cancellation cleanup finished"));
	assert.equal(inventory.length, 1);
	for (const part of [path, "owner-draft", `keel/${s.root.id}/`])
		assert.ok(inventory[0]!.includes(part), inventory[0]);
	assert.match(inventory[0]!, /branch/i);
	assert.equal(
		await readFile(join(path, "owner-draft"), "utf8"),
		"Do not discard this",
	);
	const stops = (
		await harness.commit((tx) => tx.scanTasks({ kind: "keel.stop" }, 100), ctx)
	).items;
	assert.ok(stops.every((t) => t.conversationId !== s.root.id));
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
