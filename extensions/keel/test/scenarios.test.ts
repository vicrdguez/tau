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
	if (process.env.KEEL_OWED_OUT_RENDERS) {
		const { d, text } = await openAsk(s, "verify");
		await writeFile(
			"/tmp/keel-owed-out-handover.md",
			`Title: ${d.title}\nChoices: ${d.choices.join(", ")}\n\n${text}`,
		);
	}
	await s.accept(trunk);
});

async function openAsk(
	s: Awaited<ReturnType<typeof openScenario>>,
	lane: string,
) {
	const { harness } = s.store;
	const slots = Object.values(
		(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
	);
	const slot = slots.find((a) => a.lane === lane);
	assert.ok(slot, `missing ${lane} decision`);
	const d = await harness.commit((tx) => decision(tx, slot.decision), ctx);
	assert.ok(d?.status === "open");
	const basis = await harness.commit((tx) => tx.entry(d.basis), ctx);
	return { d, text: String((basis!.data as JsonObject).text) };
}

test("rejected hand-over findings go through investigation; defer parks one, build seeds new work, and the next hand-over has no owed list", async (t) => {
	const { root } = await fixture(t);
	const s = await openScenario(root, new MemoryStorage(), "rework");
	const { harness } = s.store;
	t.after(() => harness.close(ctx));
	await s.start();
	await s.settle();
	const ask = (lane: string) => openAsk(s, lane);
	const first = await ask("verify");
	const before = git(root, "rev-parse", "trunk");
	const deferred = "Keep an example of the previous book format.";
	const change = "Add a runnable book-format regression check.";
	const reference = "Approved book format";
	const reject = (
		d: typeof first.d,
		annotations: { start: number; end: number; text: string }[],
	) =>
		fauxAnswer(s.store, d.id, {
			basis: d.basis,
			choice: "reject",
			annotations,
		});
	assert.equal((await reject(first.d, [])).kind, "answered");
	await s.settle();
	const askedAgain = await ask("verify");
	assert.notEqual(first.d.id, askedAgain.d.id);
	assert.equal(
		(
			await reject(askedAgain.d, [
				{ start: 0, end: 1, text: deferred },
				{ start: 1, end: 2, text: change },
			])
		).kind,
		"answered",
	);
	s.queueProvider.setResponses([
		...[deferred, change].map((text, index) =>
			s.turn(
				"investigator",
				"report_investigation",
				{
					finding: index + 2,
					classification: "determined",
					evidence:
						index === 0
							? "The earlier format is in Git."
							: "There is no runnable check in the landed tree.",
					size: "small",
					cause: index === 0 ? "book format history" : "book format regression",
					recommendation: index === 0 ? "defer" : "build",
					reference,
				},
				text,
				"Source: owner",
				before,
				"The integrated book matches the approved format.",
			),
		),
	]);
	await s.settle();
	assert.equal(s.queueProvider.getPendingResponseCount(), 0);
	const parked = await ask("queue");
	assert.ok(parked.text.includes(deferred));
	const answer = (d: typeof first.d, choice: string) =>
		fauxAnswer(s.store, d.id, { basis: d.basis, choice, annotations: [] });
	assert.equal((await answer(parked.d, "defer")).kind, "answered");
	await s.settle();
	const triage = await ask("queue");
	assert.deepEqual(triage.d.choices, ["build", "defer", "drop"]);
	for (const part of [
		change,
		before,
		"There is no runnable check in the landed tree.",
	])
		assert.ok(triage.text.includes(part), part);
	if (process.env.KEEL_OWED_OUT_RENDERS)
		await writeFile(
			"/tmp/keel-owed-out-triage.md",
			`Title: ${triage.d.title}\nChoices: ${triage.d.choices.join(", ")}\n\n${triage.text}`,
		);
	const goal = "Keep a runnable regression check for the approved book format.";
	const proof = {
		id: "format-check",
		argv: ["sh", "check-book.sh"],
		timeoutMs: 5000,
	};
	const pass = {
		outcome: "pass",
		text: "Ran the check against the checked-out candidate.",
		blocks: [],
		notes: [],
	};
	s.provider.setResponses([
		s.turn(
			"designer",
			"ground",
			{
				route: "follow",
				reference,
				mandate: {
					intent: goal,
					nodes: [
						{ label: "format", rule: change, probe: "Run sh check-book.sh" },
					],
					checks: [proof],
				},
			},
			change,
			reference,
		),
		s.turn("coordinator", "publish_plan", {
			items: [{ id: "regression", kind: "build", goal, deps: [] }],
		}),
		s.turn("coordinator", "brief_item", {
			item: "regression",
			goal,
			evidence: reference,
			fences: "check-book.sh",
			nodes: ["format"],
		}),
		s.turn("worker", "bash", {
			command: `printf "%s\\n" "grep -qx repaired book" > check-book.sh && git add check-book.sh && git commit -m 'Check the book format'`,
		}),
		s.turn("worker", "publish_build", { summary: goal, addresses: [] }),
		s.turn("verifier", "bash", { command: "sh check-book.sh" }),
		s.turn("verifier", "publish_verdict", pass),
		s.turn("coordinator", "handoff_build", {
			summary: goal,
			risk: "Only the book format is tested.",
		}),
		s.turn("verifier", "bash", { command: "sh check-book.sh" }),
		s.turn("verifier", "publish_verdict", pass),
	]);
	assert.equal((await answer(triage.d, "build")).kind, "answered");
	await s.settle();
	const handover = await ask("verify");
	const after = git(root, "rev-parse", "trunk");
	assert.notEqual(after, before);
	assert.equal(
		git(root, "show", "trunk:check-book.sh"),
		"grep -qx repaired book",
	);
	assert.ok(handover.text.includes(after));
	assert.doesNotMatch(
		handover.text,
		/Checks still owed|Keep an example of the previous book format/i,
	);
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

test("scenario 2 puts the new and replaced bases at the top of the switched review, even when the Mandate entries are unchanged", async (t) => {
	const { root } = await fixture(t);
	await seedBookPolicy(root);
	const s = await openReview(root, new MemoryStorage(), true);
	t.after(() => s.harness.close(ctx));
	await s.start();
	const first = (await s.review("mandate/1")).text;
	await s.switchBase();
	const second = (await s.review("mandate/2")).text;
	if (process.env.KEEL_DISPATCH_FIX_RENDERS) {
		await writeFile("/tmp/keel-dispatch-fix-round1.md", first);
		await writeFile("/tmp/keel-dispatch-fix-round2.md", second);
	}
	assert.doesNotMatch(first.split("\n## Mandate", 1)[0]!, /Base switched/);
	assert.match(
		second.split("\n## Mandate", 1)[0]!,
		/Round 2\. Base switched to `arena_seat_2`, replacing `arena_seat_1`\. Since round 1: no entries changed\./,
	);
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
