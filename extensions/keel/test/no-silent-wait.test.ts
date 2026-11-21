import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, MemoryStorage } from "tau/durable";
import {
	agentKey,
	effectKey,
	subject,
	token,
	workId,
} from "../src/kernel/ids.ts";
import type { KernelEvent, LaneEvent } from "../src/kernel/lane.ts";
import { ProjectState, WorkState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { buildDoc } from "../src/lanes/build/state.ts";
import { openScriptedWorkflow } from "./fixtures/scenario.ts";

const sha = "a".repeat(40);
const rule = (label: string) => ({
	label,
	rule: `Rule ${label}.`,
	probe: `Probe ${label}.`,
});
const mandate = {
	intent: "Export the book and a statistics file",
	nodes: [rule("wire"), rule("R2")],
	checks: [{ id: "P1", argv: ["true"], timeoutMs: 1000 }],
};
const goal = (id: string, deps: string[] = []) => ({
	id,
	kind: "build",
	goal: `Build ${id}`,
	deps,
});

async function start(
	t: TestContext,
	ids = ["writer", "stats"],
	deps: Record<string, string[]> = {},
) {
	const s = await openScriptedWorkflow(
		process.cwd(),
		new MemoryStorage(),
		true,
	);
	const { harness } = s.store;
	t.after(() => harness.close(ctx));
	const work = workId(s.root.id);
	const commit = <T>(fn: Parameters<typeof harness.commit<T>>[0]) =>
		harness.commit(fn, ctx);
	const send = (lane: string, event: LaneEvent) =>
		commit((tx) =>
			s.transact(tx, { lane, work: lane === "queue" ? null : work, event }, 1),
		);
	const must = async (lane: string, event: LaneEvent) => {
		const r = await send(lane, event);
		assert.ok(!("reject" in r), JSON.stringify(r));
	};
	const fact = (fact: KernelEvent) =>
		commit((tx) => s.transact(tx, { lane: "build", work, fact }, 1));
	const asks = async () =>
		Object.values(
			(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
		);
	async function readAsk(local: string) {
		const slot = (await asks()).find((a) => a.local.startsWith(local));
		assert.ok(slot, `No ${local} decision`);
		return commit(async (tx) => {
			const d = await decision(tx, slot.decision);
			assert.ok(d && d.status === "open");
			const entry = await tx.entry(d.basis);
			return { slot, d, text: (entry?.data as { text: string }).text };
		});
	}
	async function answer(local: string, choice: string, text?: string) {
		const { slot, d } = await readAsk(local);
		await commit((tx) =>
			s.transact(
				tx,
				{
					lane: slot.lane,
					work: slot.work,
					fact: {
						kind: "answered",
						subject: subject(slot.local),
						decision: d.id,
						choice,
						annotations: text ? [{ n: 1, text }] : [],
					},
				},
				1,
			),
		);
	}
	async function done(prefix: string, result: JsonObject) {
		const effects =
			(await harness.snapshot(stateDoc(WorkState), work, ctx))?.effects ?? {};
		const key = Object.keys(effects).findLast((k) =>
			k.startsWith(`build:${prefix}`),
		);
		assert.ok(key, `No ${prefix} effect`);
		await commit((tx) =>
			s.transact(
				tx,
				{
					lane: "build",
					work,
					fact: { kind: "effect_done", key: effectKey(key.slice(6)), result },
				},
				1,
			),
		);
	}
	async function brief(id: string, label = "wire") {
		await must("build", {
			kind: "brief",
			item: id,
			goal: `Goal ${id}`,
			evidence: `Probe ${id}`,
			fences: `src/${id}`,
			nodes: [label],
		});
		await done(`worker:${work}:${id}:`, {
			kind: "worktree",
			base: sha,
			principles: [],
		});
	}
	async function merge(id: string, head: string) {
		await must("build", {
			kind: "publish",
			agent: `worker/${id}/1`,
			summary: `Published ${id}`,
			addresses: [],
			facts: { kind: "ok", sha: head, base: sha, changedPolicyFiles: [] },
		});
		await must("build", { kind: "merged", item: id, head });
		await done(`remove:worker:${work}:${id}:`, { kind: "removed" });
	}
	const file = (
		item: string,
		text: string,
		blocking = true,
		pattern: string | null = null,
	) =>
		must("queue", {
			kind: "intake",
			work,
			source: "worker",
			item,
			text,
			blocking,
			sha: null,
			nodes: [],
			report: null,
			edgeCase: null,
			pattern,
		});
	const classify = (finding: number, extra: JsonObject = {}) =>
		send("queue", {
			kind: "investigated",
			finding,
			classification: "defect_in_scope",
			cause: "shared parser defect",
			recommendation: "build",
			size: "small",
			evidence: "Reproduced.",
			nodes: [],
			...extra,
		});
	const plan = (items: ReturnType<typeof goal>[]) =>
		send("build", { kind: "plan", items, replies: [] });
	const build = () => harness.snapshot(stateDoc(buildDoc), work, ctx);
	const changeBuild = (
		change: (state: ReturnType<typeof buildDoc.initial>) => void,
	) => commit(async (tx) => change(await tx.doc(stateDoc(buildDoc), work)));
	await must("design", {
		kind: "ground",
		route: "follow",
		reference: "Export ADR",
		mandate,
	});
	await done("discover:", {
		kind: "repo",
		repo: {
			root: process.cwd(),
			commonDir: `${process.cwd()}/.git`,
			base: "main",
			trunk: "trunk",
			baseHead: sha,
			trunkHead: sha,
		},
	});
	await done("start:", { kind: "started", base: sha });
	assert.ok(!("reject" in (await plan(ids.map((id) => goal(id, deps[id]))))));
	return {
		work,
		send,
		must,
		asks,
		readAsk,
		answer,
		brief,
		merge,
		file,
		classify,
		plan,
		build,
		changeBuild,
		fact,
		commit,
		options: s.options,
	};
}

test("X1: a late hold on a fix dependency leads to one decision; resume gives the coordinator that picture and the owner's direction", async (t) => {
	const x = await start(t);
	await x.brief("writer");
	await x.brief("stats", "R2");
	await x.file("writer", "PARSER: escaped colons get dropped");
	assert.ok(!("reject" in (await x.classify(1))));
	assert.ok(!("reject" in (await x.plan([goal("fix", ["stats"])]))));
	await x.commit(async (tx) =>
		x.options.set(tx, { ...(await x.options.get(tx)), sweep_minutes: 60 }),
	);
	// Replay the hold that a pre-refusal link delivered to Build.
	await x.must("build", {
		kind: "queue_hold",
		item: "stats",
		nodes: [],
		cause: "queue/1",
	});
	assert.equal((await x.asks()).length, 1);
	const { d, text } = await x.readAsk("finding/");
	assert.deepEqual(d.choices, ["resume", "cancel"]);
	assert.match(text, /writer.*escaped colons get dropped/);
	assert.match(text, /stats.*escaped colons get dropped/);
	assert.match(text, /fix.*depends on stats/);
	await x.answer("finding/", "resume", "Make the fix independent of stats.");
	assert.deepEqual(await x.asks(), []);
	const { items, coordinator } = (await x.build())!;
	assert.equal(coordinator.tool, "publish_plan");
	assert.ok(
		items.find((i) => i.id === "stats")?.parked,
		"resume does not release the cause",
	);
	assert.match(coordinator.direction, /fix.*depends on stats/);
	assert.match(coordinator.direction, /Make the fix independent of stats/);
	assert.ok(
		!("reject" in (await x.plan([goal("writer"), goal("stats"), goal("fix")]))),
	);
	assert.equal((await x.build())?.coordinator.item, "fix");
});

test("X2: a fix blocked on its own finding leads to one decision", async (t) => {
	const x = await start(t, ["writer"]);
	await x.brief("writer");
	await x.file("writer", "Parser defect");
	assert.ok(!("reject" in (await x.classify(1))));
	assert.ok(!("reject" in (await x.plan([goal("fix")]))));
	await x.brief("fix");
	// Replay the hold delivered by the formerly accepted self-link.
	await x.must("build", {
		kind: "queue_hold",
		item: "fix",
		nodes: [],
		cause: "queue/1",
	});
	assert.equal((await x.asks()).length, 1);
	assert.match((await x.readAsk("finding/")).text, /fix.*Parser defect/);
});

for (const filer of ["direct", "transitive", "fix"] as const) {
	test(`A-1: an investigator cannot link the ${filer} filer to its own fix`, async (t) => {
		const x = await start(
			t,
			filer === "fix"
				? ["writer"]
				: filer === "transitive"
					? ["writer", "stats", "reader"]
					: undefined,
			{ reader: ["stats"] },
		);
		await x.brief("writer");
		if (filer !== "fix") await x.brief("stats", "R2");
		await x.file("writer", "The parser loses its escape.");
		assert.ok(!("reject" in (await x.classify(1))));
		const items =
			filer === "transitive"
				? [goal("fix", ["reader"])]
				: [goal("fix", filer === "direct" ? ["stats"] : [])];
		assert.ok(!("reject" in (await x.plan(items))));
		if (filer === "fix") await x.brief("fix");
		const item = filer === "fix" ? "fix" : "stats";
		await x.file(item, "The same defect would block the fix if linked.");
		assert.deepEqual(
			await x.asks(),
			[],
			"the investigator is still expected to act",
		);
		const linked = await x.classify(2, { sameAs: 1 });
		assert.match(
			"reject" in linked ? linked.reject : "",
			new RegExp(`${item}.*fix.*without linking`, "i"),
		);
		assert.ok(
			!("reject" in (await x.classify(2))),
			"the investigator can report a separate defect",
		);
		assert.ok(!("reject" in (await x.plan([goal("different-fix")]))));
		assert.equal((await x.build())?.coordinator.item, "different-fix");
	});
}

test("X3: a coordinator stalled on an approved removal reports the held item in one decision", async (t) => {
	const x = await start(t, ["stats"]);
	await x.brief("stats", "R2");
	await x.file("stats", "Statistics rule R2 is wrong; drop it", false);
	assert.ok(
		!(
			"reject" in
			(await x.classify(1, { classification: "mandate_wrong", nodes: ["R2"] }))
		),
	);
	await x.answer("triage/", "build");
	await x.must("design", {
		kind: "publish_revision",
		changes: { remove: ["R2"] },
		answers: [
			{ cause: "queue/1", nodes: ["R2"], reason: "Remove the wrong rule." },
		],
		replies: [],
	});
	assert.equal(
		(await x.asks()).length,
		1,
		"the owner's revision review is already open",
	);
	await x.answer("revision/", "approve");
	assert.deepEqual(await x.plan([goal("stats")]), {
		reject: "Item stats cites R2, a removed Mandate node.",
	});
	const { coordinator } = (await x.build())!;
	await x.fact({
		kind: "agent_stalled",
		agent: agentKey("coordinator"),
		tokens: [token("publish_plan", coordinator.seq)],
		cause: "unfulfilled",
		lastWords: "No revision plan can apply.",
	});
	assert.equal((await x.asks()).length, 1);
	assert.match(
		(await x.readAsk("finding/")).text,
		/stats.*Statistics rule R2 is wrong/,
	);
});

test("A-3: determined triage keeps both filers held until both planned items merge, then restarts them at the final head", async (t) => {
	const x = await start(t);
	await x.brief("writer");
	await x.brief("stats", "R2");
	const determined = {
		classification: "determined",
		reference: "Approved framing ADR",
	};
	await x.file("writer", "Which escape does the approved format require?");
	assert.ok(!("reject" in (await x.classify(1, determined))));
	await x.file("stats", "The reader needs that same approved escape.");
	assert.ok(!("reject" in (await x.classify(2, { ...determined, sameAs: 1 }))));
	await x.answer("triage/", "build");
	assert.ok((await x.build())?.items.every((i) => i.parked));
	assert.ok(
		!("reject" in (await x.plan([goal("format"), goal("reader", ["format"])]))),
	);
	await x.brief("format");
	await x.merge("format", "b".repeat(40));
	assert.ok(
		(await x.build())?.items
			.slice(0, 2)
			.every((i) => i.parked && i.attempt === 1),
	);
	await x.brief("reader");
	const head = "c".repeat(40);
	await x.merge("reader", head);
	for (const item of (await x.build())!.items.slice(0, 2)) {
		assert.equal(item.attempt, 2);
		assert.equal(item.worker?.base, head);
	}
});

test("A-3: a revision plan can add a dependency to a held filer that did not cite the changed node", async (t) => {
	const x = await start(t, ["writer"]);
	await x.brief("writer");
	await x.file("writer", "The R2 rule contradicts the export.");
	assert.ok(
		!(
			"reject" in
			(await x.classify(1, { classification: "mandate_wrong", nodes: ["R2"] }))
		),
	);
	await x.answer("triage/", "build");
	await x.must("design", {
		kind: "publish_revision",
		changes: {
			nodes: [{ ...rule("R2"), rule: "Frame statistics like the book." }],
		},
		answers: [{ cause: "queue/1", nodes: ["R2"], reason: "One framing." }],
		replies: [],
	});
	await x.answer("revision/", "approve");
	const plan = await x.plan([
		goal("writer", ["r2frame"]),
		goal("r2frame"),
		goal("probe", ["r2frame"]),
	]);
	assert.ok(!("reject" in plan), JSON.stringify(plan));
	await x.brief("r2frame", "R2");
	await x.merge("r2frame", "b".repeat(40));
	assert.ok(
		(await x.build())?.items[0]?.parked,
		"its declared dependency merged, but the rest of the fix has not",
	);
	await x.brief("probe", "R2");
	const head = "c".repeat(40);
	await x.merge("probe", head);
	assert.equal((await x.build())?.items[0]?.attempt, 2);
	assert.equal((await x.build())?.items[0]?.worker?.base, head);
});

test("a synthetic cycle among held unfinished items opens one decision, not one per item", async (t) => {
	const x = await start(t, ["left", "right"]);
	await x.brief("left");
	await x.brief("right");
	await x.changeBuild((s) => {
		s.items[0]!.deps = ["right"];
		s.items[1]!.deps = ["left"];
	});
	await x.must("build", {
		kind: "queue_hold",
		item: "left",
		nodes: [],
		cause: "queue/1",
		evidence: "### Finding #1: Left cannot continue",
	});
	await x.must("build", {
		kind: "queue_hold",
		item: "right",
		nodes: [],
		cause: "queue/2",
		evidence: "### Finding #2: Right cannot continue",
	});
	assert.equal((await x.asks()).length, 1);
	const { text } = await x.readAsk("finding/");
	assert.match(text, /left.*Left cannot continue.*depends on right/);
	assert.match(text, /right.*Right cannot continue.*depends on left/);
	await x.answer("finding/", "cancel");
	assert.deepEqual(await x.asks(), []);
});

test("a pending Verify checkout is progress for an unfinished build", async (t) => {
	const x = await start(t);
	await x.brief("writer");
	await x.brief("stats");
	await x.must("build", {
		kind: "queue_hold",
		item: "stats",
		nodes: [],
		cause: "queue/1",
		evidence: "### Finding #1: Stats cannot continue",
	});
	await x.must("build", {
		kind: "publish",
		agent: "worker/writer/1",
		summary: "Export ready",
		addresses: [],
		facts: {
			kind: "ok",
			sha: "b".repeat(40),
			base: sha,
			changedPolicyFiles: [],
		},
	});
	assert.deepEqual(await x.asks(), []);
});
