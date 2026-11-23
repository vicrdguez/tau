import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, MemoryStorage } from "tau/durable";
import { openScriptedWorkflow } from "./fixtures/kernel.ts";
import { tempRepo, git } from "./fixtures/repo.ts";
import { latch } from "./toy.ts";

test("a worker's pattern citation files from its commit without blocking; a later ruling follows the blessing without filing", {
	timeout: 15000,
}, async (t) => {
	const { root } = await tempRepo(t);
	const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
	const { harness } = s.store;
	const recorded = latch<void>();
	const blessed = latch<void>();
	t.after(async () => {
		blessed.resolve();
		await s.close();
	});
	const { turn } = s;
	const goal = "Repair the book";
	const pattern = "preserve-the-last-line";
	const first = {
		what: "Preserve the last line before rewriting the book.",
		why: "The legacy reader expects it.",
		cost: "Readers could lose a posting.",
		rank: 3,
		follows: pattern,
		pattern: true,
	};
	const second = {
		...first,
		what: "Keep the last line for the recovery path as well.",
	};
	const head = () => git(root, "rev-parse", `keel/${s.root.id}/item/book-1`);
	s.queueProvider.setResponses([
		(...args) =>
			turn(
				"investigator",
				"report_investigation",
				{
					finding: 1,
					classification: "unapproved_pattern",
					evidence: "Two live readers use the same final line.",
					size: "small",
					cause: "Last line as a boundary",
					recommendation: "bless",
				},
				head(),
				first.what,
				first.why,
				first.cost,
				pattern,
				"format",
			)(...args),
	]);
	const pass = turn("verifier", "publish_verdict", {
		outcome: "pass",
		text: "The book matches.",
		blocks: [],
		notes: [],
	});
	s.provider.setResponses([
		turn("designer", "ground", {
			route: "follow",
			reference: "Approved book format",
			mandate: {
				intent: goal,
				nodes: [
					{
						label: "format",
						rule: "Keep the book readable",
						probe: "Read the last line",
					},
				],
				checks: [
					{
						id: "book-check",
						argv: ["grep", "-qx", "repaired", "book"],
						timeoutMs: 5000,
					},
				],
			},
		}),
		turn("coordinator", "publish_plan", {
			items: [{ id: "book", kind: "build", goal, deps: [] }],
		}),
		turn("coordinator", "brief_item", {
			item: "book",
			goal,
			evidence: "Check the final line",
			fences: "book",
			nodes: ["format"],
		}),
		turn("worker", "bash", {
			command: "printf 'repaired\\n' > book && git commit -am 'restore book'",
		}),
		turn("worker", "record_ruling", first),
		async (...args) => {
			recorded.resolve();
			await blessed.promise;
			return turn("worker", "record_ruling", second)(...args);
		},
		turn("worker", "publish_build", {
			summary: "Repaired book",
			addresses: [],
		}),
		pass,
		turn("coordinator", "handoff_build", {
			summary: goal,
			risk: "Only ledger readers changed",
		}),
		pass,
	]);
	harness.resume();
	await s.submit(goal);
	await recorded.promise;
	const delivery = (
		await harness.commit(
			(tx) => tx.scanTasks({ kind: "keel.deliver" }, 100),
			ctx,
		)
	).items.find((r) => (r.input as JsonObject).lane === "queue");
	assert.ok(
		delivery,
		"the ruling must schedule investigation, not hold the worker",
	);
	await harness.waitForTask(delivery.id, ctx);
	const [triage] = await s.asks();
	assert.equal(triage?.lane, "queue");
	const { d } = await s.readAsk(triage!);
	assert.deepEqual(d.choices, ["bless", "revoke", "defer"]);
	await s.answer(d, "bless");
	const answer = (
		await harness.commit((tx) => tx.scanTasks({ kind: "keel.answer" }, 10), ctx)
	).items[0];
	assert.ok(answer);
	await harness.waitForTask(answer.id, ctx);
	assert.deepEqual(await s.asks(), []);
	blessed.resolve();
	await s.settle();
	assert.equal(s.queueProvider.getPendingResponseCount(), 0);
	const deliveries = (
		await harness.commit(
			(tx) => tx.scanTasks({ kind: "keel.deliver" }, 100),
			ctx,
		)
	).items;
	assert.deepEqual(
		deliveries
			.filter((r) => (r.input as JsonObject).lane === "queue")
			.map(({ id }) => id),
		[delivery.id],
	);
	const open = await s.asks();
	assert.deepEqual(
		open.map((a) => a.local),
		["handover"],
	);
	assert.ok((await s.readAsk(open[0]!)).text.includes(second.what));
});
