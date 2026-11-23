import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, MemoryStorage } from "tau/durable";
import { fauxAssistantMessage, fauxToolCall } from "tau/testing";
import { agentKey, subject, token } from "../src/kernel/ids.ts";
import type { KernelEvent, LaneEvent } from "../src/kernel/lane.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { buildDoc } from "../src/lanes/build/state.ts";
import { openScriptedWorkflow } from "./fixtures/kernel.ts";
import { tempRepo } from "./fixtures/repo.ts";

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
	t.after(s.close);
	const { work, send, asks } = s;
	const must = async (lane: string, event: LaneEvent) => {
		const r = await send(lane, event);
		assert.ok(!("reject" in r), JSON.stringify(r));
	};
	const fact = (fact: KernelEvent, lane = "build") => s.fact(lane, fact);
	async function readAsk(local: string) {
		const slot = (await asks()).find((a) => a.local.startsWith(local));
		assert.ok(slot, `No ${local} decision`);
		return s.readAsk(slot);
	}
	async function answer(local: string, choice: string, text?: string) {
		const { slot, d } = await readAsk(local);
		await fact(
			{
				kind: "answered",
				subject: subject(slot.local),
				decision: d.id,
				choice,
				annotations: text ? [{ n: 1, text }] : [],
			},
			slot.lane,
		);
	}
	const done = (prefix: string, result: JsonObject) =>
		s.done("build", prefix, result);
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
		fact,
		commit: s.commit,
		options: s.options,
	};
}

test("cancelling the last active investigation exposes a wait; resume delivers the evidence and owner direction", async (t) => {
	const x = await start(t);
	await x.brief("writer");
	await x.brief("stats", "R2");
	await x.file("writer", "PARSER: escaped colons get dropped");
	assert.ok(!("reject" in (await x.classify(1))));
	assert.ok(!("reject" in (await x.plan([goal("fix", ["stats"])]))));
	await x.file("stats", "An unrelated, non-blocking observation", false);
	await x.commit(async (tx) =>
		x.options.set(tx, { ...(await x.options.get(tx)), sweep_minutes: 60 }),
	);

	// A project timer is not work progress. Deliver a late hold on the dependency at the lane routing seam, not by editing stored state.
	await x.must("build", {
		kind: "queue_hold",
		item: "stats",
		nodes: [],
		cause: "queue/late",
		evidence: "Stats cannot continue",
	});
	assert.deepEqual(
		await x.asks(),
		[],
		"the live investigator can still move the work",
	);
	await x.fact(
		{
			kind: "agent_stalled",
			agent: agentKey("investigator"),
			tokens: [token("investigate/2", 0)],
			cause: "stopped",
			lastWords: "",
		},
		"queue",
	);
	assert.deepEqual(
		(await x.asks()).map((a) => a.local),
		["investigate/2/0"],
	);
	await x.answer("investigate/", "cancel");

	assert.equal((await x.asks()).length, 1);
	const { d, text } = await x.readAsk("finding/");
	assert.deepEqual(d.choices, ["resume", "cancel"]);
	assert.match(text, /writer.*escaped colons get dropped/);
	assert.match(text, /stats.*Stats cannot continue/);
	assert.match(text, /fix.*depends on stats/);
	await x.answer("finding/", "resume", "Make the fix independent of stats.");
	const { items, coordinator } = (await x.build())!;
	assert.equal(coordinator.tool, "publish_plan");
	assert.ok(
		items.find((i) => i.id === "stats")?.parked,
		"resume does not release the hold",
	);
	assert.match(coordinator.direction, /fix.*depends on stats/);
	assert.match(coordinator.direction, /Make the fix independent of stats/);
	assert.ok(
		!("reject" in (await x.plan([goal("writer"), goal("stats"), goal("fix")]))),
	);
	assert.equal((await x.build())?.coordinator.item, "fix");
});

// A filer can be the fix itself, or reach it through existing dependencies.
for (const filer of ["transitive", "fix"] as const) {
	test(`an investigator cannot link a ${filer} filer to its own fix`, async (t) => {
		const ids = filer === "fix" ? ["writer"] : ["writer", "stats", "reader"];
		const x = await start(t, ids, { reader: ["stats"] });
		await x.brief("writer");
		if (filer === "transitive") await x.brief("stats", "R2");
		await x.file("writer", "The parser loses its escape.");
		assert.ok(!("reject" in (await x.classify(1))));
		assert.ok(
			!(
				"reject" in
				(await x.plan([goal("fix", filer === "fix" ? [] : ["reader"])]))
			),
		);
		if (filer === "fix") await x.brief("fix");
		const item = filer === "fix" ? "fix" : "stats";
		await x.file(item, "The same defect would block the fix if linked.");
		const linked = await x.classify(2, { sameAs: 1 });
		assert.match(
			"reject" in linked ? linked.reject : "",
			new RegExp(`${item}.*fix.*without linking`, "i"),
		);
		assert.ok(!("reject" in (await x.classify(2))));
		assert.ok(!("reject" in (await x.plan([goal("different-fix")]))));
		assert.equal((await x.build())?.coordinator.item, "different-fix");
	});
}

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

test("A-n1: approval without notes releases an already-settled cause without a plan turn", async (t) => {
	const x = await start(t, ["writer"]);
	await x.brief("writer");
	await x.file("writer", "Do records already require escaping?");
	assert.ok(
		!(
			"reject" in
			(await x.classify(1, {
				classification: "mandate_wrong",
				nodes: ["wire"],
			}))
		),
	);
	await x.answer("triage/", "build");
	await x.must("design", {
		kind: "publish_revision",
		changes: {},
		answers: [
			{
				cause: "queue/1",
				nodes: ["wire"],
				reason: "The bound wire rule already requires escaping.",
			},
		],
		replies: [],
	});
	assert.equal((await x.build())?.items[0]?.parked, true);
	await x.answer("revision/", "approve");
	const build = (await x.build())!;
	assert.equal(build.coordinator.tool, null);
	assert.equal(build.items[0]?.parked, false);
	assert.deepEqual(build.queueHolds, []);
	assert.deepEqual(await x.asks(), []);
});

test("a coordinator stall after resume shows the refused plan's error, not a prior turn's error", async (t) => {
	const { root } = await tempRepo(t);
	const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
	t.after(s.close);
	const noPlan = fauxAssistantMessage("I could not publish a plan.");
	s.provider.setResponses([
		s.turn("designer", "ground", {
			route: "follow",
			reference: "Export ADR",
			mandate,
		}),
		noPlan,
		noPlan,
	]);
	await (await s.submit(mandate.intent)).wait(ctx);
	await s.settle();
	async function openHolding() {
		const open = await s.asks();
		assert.equal(open.length, 1);
		return s.readAsk(open[0]!);
	}
	async function resume(d: Awaited<ReturnType<typeof openHolding>>["d"]) {
		await s.answer(d, "resume");
		await s.settle();
	}
	const first = await openHolding();
	s.provider.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("publish_plan", { items: [goal("writer", ["missing"])] })],
			{ stopReason: "toolUse" },
		),
		noPlan,
		noPlan,
	]);
	await resume(first.d);
	const stalled = await openHolding();
	assert.match(stalled.text, /I could not publish a plan/);
	assert.match(stalled.text, /A dependency is missing from the plan\./);

	s.provider.setResponses([noPlan, noPlan]);
	await resume(stalled.d);
	assert.doesNotMatch(
		(await openHolding()).text,
		/A dependency is missing from the plan\./,
	);
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
