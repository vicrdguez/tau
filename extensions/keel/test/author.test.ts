import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type Conversation, defineTool, type JsonObject } from "tau/durable";
import { obj, str } from "tau/schema";
import { fauxAssistantMessage } from "tau/testing";
import { agentKey, token, type WorkId } from "../src/kernel/ids.ts";
import { defineLane, defineLaneTool, type Lane } from "../src/kernel/lane.ts";
import { BindingState, ProjectState } from "../src/kernel/records.ts";
import { defineState, stateDoc } from "../src/kernel/state.ts";
import { latch, toolTurn, toy } from "./toy.ts";

const plan = defineState({
	kind: "keel.plan",
	version: 1,
	scope: "conversation",
	initial: () => ({ phase: "empty", root: "", answered: [] as string[] }),
});
const lane: Lane<ReturnType<typeof plan.initial>> = {
	name: "plan",
	state: plan,
	view: (s) => ({ ...s, stage: () => s.phase }),
	asks: () => [],
	agents: (s) =>
		s.phase === "empty" || s.phase === "retired"
			? []
			: [
					{
						key: agentKey("designer"),
						role: "designer",
						cwd: null,
						paused: s.phase === "paused",
						expects:
							s.phase === "seeded"
								? [
										{
											token: token("seed", 1),
											tools: ["start"],
											input: () => "Ground the queue seed",
										},
									]
								: s.phase === "two"
									? ["A", "B"]
											.filter((k) => !s.answered.includes(token(k, 1)))
											.map((k) => ({
												token: token(k, 1),
												tools: ["brief"],
												input: () => `Prepare ${k}`,
											}))
									: [],
					},
				],
	effects: () => [],
	onFact: (state) => ({ state }),
	reduce(s, e, world) {
		if (e.kind === "reject") return { reject: "not adopted" };
		if (e.kind === "brief")
			return { state: { ...s, answered: [...s.answered, String(e.token)] } };
		return { state: { ...s, phase: e.kind, root: world.root } };
	},
};
const queue = defineState({
	kind: "keel.queueTest",
	version: 1,
	scope: "session",
	initial: () => ({ log: [] as string[] }),
});
const queueLane = defineLane({
	name: "queue",
	state: queue,
	view: (s) => s,
	agents: () => [],
	effects: () => [],
	asks: () => [],
	onFact: (state) => ({ state }),
	reduce(s, e, w) {
		if (e.kind === "seed")
			return {
				state: s,
				send: [
					{ lane: "plan", work: "new", event: { kind: String(e.action) } },
				],
			};
		const current = w.view("plan", e.work as WorkId) as { phase: string };
		return {
			state: { log: [...s.log, `${e.observed}/${current.phase}/${e.work}`] },
		};
	},
});
const adopt = defineLaneTool({
	lane: "plan",
	roles: ["designer"],
	name: "start",
	gate: "adopt",
	description: "Start",
	parameters: obj({ action: str() }),
	terminate: true,
	event: (args) => ({ kind: args.action }),
});
const file = defineLaneTool({
	lane: "queue",
	roles: ["designer"],
	name: "file",
	gate: "standing",
	description: "File",
	parameters: obj({}),
	terminate: true,
	observe: async (_args, _self, _ctx, view) => {
		const v = view("plan") as { phase: string; stage(): string };
		const phase = v.stage();
		v.phase = "tampered";
		return phase;
	},
	event: (_, observed, self) => ({ kind: "file", observed, work: self.work }),
});
const brief = defineLaneTool({
	lane: "plan",
	roles: ["designer"],
	name: "brief",
	description: "Brief the current item",
	parameters: obj({}),
	terminate: true,
	event: (_, __, self) => ({ kind: "brief", token: self.token }),
});
const principle = defineTool({
	name: "principle",
	description: "Read",
	parameters: obj({}),
	execute: async () => ({}),
});
async function setup(t: TestContext) {
	const x = await toy({
		lanes: [defineLane(lane), queueLane],
		tools: [adopt, file, brief],
		plainTools: [{ roles: ["designer"], tool: principle }],
		sections: [
			{
				roles: ["designer"],
				section: { key: "index", render: () => "designer index" },
			},
			{
				roles: ["worker"],
				section: { key: "secret", render: () => "worker index" },
			},
		],
	});
	t.after(() => x.harness.close(ctx));
	async function call(
		name: string,
		args: JsonObject = {},
		conv: Conversation = x.root,
	) {
		const { result } = await x.request(conv, name, args);
		assert.ok(result);
		return result;
	}
	return { x, call };
}
test("adoption binds only the successful first call; standing project tools observe and resolve the caller's work", async (t) => {
	const { x, call } = await setup(t);
	assert.equal((await call("file")).isError, true);
	assert.equal((await call("start", { action: "reject" })).isError, true);
	assert.equal(
		(await x.harness.snapshot(stateDoc(BindingState), x.root.id, ctx))
			?.binding ?? null,
		null,
	);
	assert.equal((await call("start", { action: "active" })).isError, false);
	const binding = (
		await x.harness.snapshot(stateDoc(BindingState), x.root.id, ctx)
	)?.binding;
	assert.deepEqual(binding, {
		work: x.root.id,
		lane: "plan",
		role: "designer",
		key: "designer",
	});
	assert.deepEqual(
		(await x.harness.snapshot(stateDoc(ProjectState), ctx))?.works,
		[x.root.id],
	);
	assert.equal((await call("start", { action: "again" })).isError, true);
	assert.equal((await call("file")).isError, false);
	assert.deepEqual((await x.harness.snapshot(stateDoc(queue), ctx))?.log, [
		`active/active/${x.root.id}`,
	]);
	await x.deliver("plan", x.root.id, { kind: "paused" });
	await x.finish("keel.stop");
	assert.equal((await call("file")).isError, true);
});
test("queue seed creates a different anchored work; rejected seed leaks no conversation", async (t) => {
	const { x, call } = await setup(t);
	await call("start", { action: "active" });
	const count = () =>
		x.harness.commit(
			async (tx) => (await tx.scanConversations({}, 100)).items.length,
			ctx,
		);
	const before = await count();
	await assert.rejects(
		x.deliver("queue", null, { kind: "seed", action: "reject" }),
		/not adopted/,
	);
	assert.equal(await count(), before);
	const release = latch<void>();
	x.provider.setResponses([
		async () => {
			await release.promise;
			return toolTurn("start", { action: "grounded" });
		},
		fauxAssistantMessage("done"),
		fauxAssistantMessage("done"),
	]);
	await x.deliver("queue", null, { kind: "seed", action: "seeded" });
	const works = (await x.harness.snapshot(stateDoc(ProjectState), ctx))?.works;
	assert.ok(works);
	assert.equal(works.length, 2);
	const other = works.find((id) => id !== x.root.id);
	assert.ok(other);
	assert.equal(
		(await x.harness.snapshot(stateDoc(plan), other, ctx))?.phase,
		"seeded",
	);
	assert.equal(
		(await x.harness.snapshot(stateDoc(BindingState), other, ctx))?.binding
			?.work,
		other,
	);
	release.resolve();
	x.harness.resume();
	await x.finish("keel.deliver");
	assert.equal(
		(await x.harness.snapshot(stateDoc(plan), other, ctx))?.phase,
		"grounded",
	);
});
test("when two handoffs for the same tool are open, the latest input cannot disambiguate them", async (t) => {
	const { x, call } = await setup(t);
	await x.deliver("plan", x.root.id, { kind: "two" });
	for (const delivery of await x.tasks("keel.deliver"))
		await x.harness.abortTask(delivery.id, ctx);
	// Both inputs precede the assistant. Drive placement directly rather than racing two watchers.
	for (const key of ["A", "B"])
		await x.harness.commit(
			(tx) =>
				tx.appendEntry(x.root.id, {
					kind: "keel.input",
					data: { token: token(key, 1) },
				}),
			ctx,
		);
	const result = await call("brief");
	assert.equal(result.isError, true);
	assert.match(
		JSON.stringify(result.content),
		/Ambiguous open expectation for brief/,
	);
	assert.deepEqual(
		(await x.harness.snapshot(stateDoc(plan), x.root.id, ctx))?.answered,
		[],
	);
});
test("a plain tool admits only an active bound agent", async (t) => {
	const { x, call } = await setup(t);
	assert.equal((await call("principle")).isError, true, "unbound entry");
	await call("start", { action: "active" });
	assert.equal((await call("principle")).isError, false, "bound and active");
	for (const kind of ["paused", "retired"]) {
		await x.deliver("plan", x.root.id, { kind });
		await x.finish("keel.stop");
		assert.equal((await call("principle")).isError, true, kind);
	}
});
test("plain tools and prompt sections follow role assignments even at entry", async (t) => {
	const { x } = await setup(t);
	const agent = await x.root.agent(ctx);
	assert.ok(agent.tools.some((t) => t.name === "principle"));
	const { prompt } = await x.request();
	assert.match(prompt, /designer index/);
	assert.doesNotMatch(prompt, /worker index/);
});
