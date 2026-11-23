import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { type DecisionId, decision, eventLog } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	type FauxResponseStep,
	fauxAnswer,
	fauxAssistantMessage,
} from "tau/testing";
import { agentKey, token, workId } from "../src/kernel/ids.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { latch, Shared, toolTurn, toy } from "./toy.ts";

async function setup(t: TestContext, opts?: Parameters<typeof toy>[0]) {
	const x = await toy(opts);
	t.after(() => x.harness.close(ctx));
	return x;
}
const id = (n: number, root: number): DecisionId =>
	`keel:${root}:toy:review#${n}`;
const publish = () => toolTurn("publish");

async function observing(t: TestContext, ...later: FauxResponseStep[]) {
	const entered = latch<void>();
	const release = latch<void>();
	t.after(() => release.resolve());
	const x = await setup(t, {
		observe: () => {
			entered.resolve();
			return release.promise;
		},
	});
	x.provider.setResponses([publish(), ...later]);
	await x.send("agent");
	x.harness.resume();
	await entered.promise;
	return { x, release: release.resolve };
}
test("identical declarations retain one decision, changed basis supersedes it, absent ask withdraws it", async (t) => {
	const x = await setup(t);
	const read = (n: number) =>
		x.harness.commit((tx) => decision(tx, id(n, x.root.id)), ctx);
	await x.send("ask", { basis: "A" });
	await x.send("ask", { basis: "A" });
	assert.equal((await read(1))?.status, "open");
	assert.equal(await read(2), undefined);
	await x.send("ask", { basis: "B" });
	assert.equal((await read(1))?.status, "superseded");
	assert.equal((await read(2))?.status, "open");
	await x.send("cancel");
	assert.equal((await read(2))?.status, "withdrawn");
});
for (const stale of [false, true])
	test(
		stale
			? "an answered decision cannot move a replacement situation"
			: "duplicate answer continuations consume the slot once and number annotations",
		async (t) => {
			const x = await setup(t);
			await x.send("ask", { basis: "A" });
			const d = await x.harness.commit(
				(tx) => decision(tx, id(1, x.root.id)),
				ctx,
			);
			assert.ok(d);
			assert.equal(d.then.task, "keel.answer");
			const a = await fauxAnswer(x.store, d.id, {
				basis: d.basis,
				choice: "accept",
				annotations: [{ text: "one" }],
			});
			assert.equal(a.kind, "answered");
			if (stale) await x.send("ask", { basis: "B" });
			else
				await x.harness.commit(
					(tx) =>
						tx.createTask(
							x.k.tasks.answer,
							{ decision: d.id, choice: "accept" },
							{
								ownership: { kind: "conversation" },
								conversationId: x.root.id,
								background: true,
							},
						),
					ctx,
				);
			x.harness.resume();
			await x.finish("keel.answer");
			const s = await x.state();
			assert.equal(s.answers, stale ? 0 : 1);
			if (stale) assert.equal(s.ask, "B");
			else assert.deepEqual(JSON.parse(s.notes[0]!), [{ text: "one", n: 1 }]);
		},
	);
test("a plain owner message matching a choice does not answer the open decision", async (t) => {
	const x = await setup(t);
	await x.send("ask", { basis: "Owner approval" });
	const read = () =>
		x.harness.commit((tx) => decision(tx, id(1, x.root.id)), ctx);
	assert.equal((await read())?.status, "open");
	x.provider.setResponses([fauxAssistantMessage("Awaiting the decision.")]);
	x.harness.resume();
	await (await x.root.submit({ type: "input", content: "accept" }, ctx)).wait(
		ctx,
	);
	await x.root.waitForIdle(ctx);
	assert.equal((await read())?.status, "open");
	assert.equal((await x.state()).answers, 0);
});

test("work scopes isolate identical local subjects; project state is shared only by routed messages", async (t) => {
	const x = await setup(t);
	const b = await x.harness.createConversation(
		{ ownership: { kind: "ownerless" } },
		ctx,
	);
	await x.send("ask", { basis: "one" });
	await x.deliver("toy", b.id, { kind: "ask", basis: "two" });
	await x.send("forward");
	await x.deliver("toy", b.id, { kind: "forward" });
	await x.send("cancel");
	assert.equal((await x.state(b.id)).ask, "two");
	assert.equal(
		(await x.harness.commit((tx) => decision(tx, id(1, b.id)), ctx))?.status,
		"open",
	);
	assert.deepEqual(await x.harness.snapshot(stateDoc(Shared), ctx), {
		seen: ["hello", "hello"],
	});
	await assert.rejects(x.deliver("shared", b.id, { kind: "bad" }), /scope/i);
	await assert.rejects(x.deliver("toy", null, { kind: "bad" }), /scope/i);
});
test("views cannot change a different lane; a routed message cycle rolls the commit back", async (t) => {
	const x = await setup(t);
	await x.send("forward");
	await x.send("tamper");
	assert.deepEqual(await x.harness.snapshot(stateDoc(Shared), ctx), {
		seen: ["hello", "after inspection"],
	});
	await assert.rejects(x.send("cycle"), /cycle/i);
});
test("one commit can ask, create a worker, and emit its note; only a later commit submits", async (t) => {
	const x = await setup(t);
	await x.send("all");
	assert.equal((await x.tasks("keel.effect")).length, 1);
	const [worker] = await x.agents();
	assert.ok(worker);
	const entries = (
		await x.harness.commit(
			(tx) => tx.scanEntries({ conversationId: worker }, 100),
			ctx,
		)
	).items;
	assert.ok(!entries.some((e) => e.kind === "keel.input"));
	const log = await x.harness.commit(
		async (tx) => tx.scanEntries({ conversationId: await eventLog(tx) }, 100),
		ctx,
	);
	assert.ok(
		log.items.some(
			(e) =>
				e.kind === "keel.event" &&
				JSON.stringify(e.data).includes(`"conversation":${worker}`),
		),
	);
	x.provider.setResponses([publish()]);
	x.harness.resume();
	await x.finish("keel.deliver");
	assert.equal((await x.state()).publications, 1);
});
test("closing a token before its delivery prevents even the first input", async (t) => {
	const x = await setup(t);
	await x.send("agent");
	await x.send("quiet");
	x.harness.resume();
	await x.finish("keel.deliver");
	assert.equal(x.provider.state.callCount, 0);
});
test("an agent that answers without its hand-off gets one nudge and then a stall", async (t) => {
	const x = await setup(t);
	x.provider.setResponses([
		fauxAssistantMessage("not yet"),
		fauxAssistantMessage("still not done"),
	]);
	await x.send("agent");
	x.harness.resume();
	await x.finish("keel.deliver");
	assert.equal(x.provider.state.callCount, 2);
	const { stalls, notes } = await x.state();
	assert.equal(stalls, 1);
	assert.deepEqual(notes, ["unfulfilled"]);
});
for (const mode of ["closed", "foreign", "untagged"] as const)
	test(`agent tool admission rejects a ${mode} expectation`, async (t) => {
		const x = await setup(t);
		await x.send("agent");
		for (const delivery of await x.tasks("keel.deliver"))
			await x.harness.abortTask(delivery.id, ctx);
		if (mode === "closed") await x.send("quiet");
		const [worker] = await x.agents();
		assert.ok(worker);
		const conv = await x.harness.conversation(worker, ctx);
		assert.ok(conv);
		x.provider.setResponses([publish(), fauxAssistantMessage("done")]);
		// A model call from this input does not belong to the worker's declared hand-off.
		const result = await conv.submit(
			{
				type: "input",
				content: "publish",
				...(mode !== "untagged" && {
					entry: {
						kind: "keel.input",
						data: { token: token(`worker/${mode === "closed" ? 0 : 1}`, 1) },
					},
				}),
			},
			ctx,
		);
		await result.wait(ctx);
		const rows = (await conv.entries({}, 100, undefined, ctx)).items;
		assert.ok(
			rows.some((e) =>
				e.model?.some((m) => m.role === "toolResult" && m.isError),
			),
		);
		assert.equal((await x.state()).publications, 0);
	});
test("a read-only observation cannot admit its old call against the next token for the same tool", async (t) => {
	const { x, release } = await observing(
		t,
		...["discarded", "idle", "idle"].map((text) => fauxAssistantMessage(text)),
	);
	await x.send("agent");
	release();
	await x.finish("keel.deliver");
	assert.equal((await x.state()).publications, 0);
});
for (const move of ["pause", "cancel"])
	test(`a rolled-back ${move} cannot stop a live agent; durable ${move} precedes stop`, async (t) => {
		const { x, release } = await observing(t);
		await assert.rejects(
			x.harness.commit(async (tx) => {
				await x.k.transact(
					tx,
					{ work: workId(x.root.id), lane: "toy", event: { kind: move } },
					0,
				);
				throw Error("rollback");
			}, ctx),
			/rollback/,
		);
		assert.equal((await x.tasks("keel.stop")).length, 0);
		await x.send(move);
		const [worker] = await x.agents();
		assert.ok(worker);
		if (move === "pause") assert.equal((await x.state()).paused, true);
		else assert.equal((await x.state()).agents, 0);
		assert.equal((await x.tasks("keel.stop")).length, 1);
		await x.finish("keel.stop");
		release();
		const input = await x.harness.commit(
			(tx) => tx.submissionByRequest(worker, token("worker/0", 1)),
			ctx,
		);
		assert.equal(input?.reason, "aborted");
		assert.equal((await x.state()).publications, 0);
	});
test("a rejected routed message publishes none of the preceding lane changes", async (t) => {
	const x = await setup(t);
	assert.deepEqual(await x.send("bounce"), { reject: "not allowed" });
	assert.equal((await x.state()).publications, 0);
});

test("a withdrawn, unclaimed effect can be declared again", async (t) => {
	let runs = 0;
	const x = await setup(t, {
		runEffect: async () => ({ value: String(++runs) }),
	});
	await x.send("effect");
	await x.send("cancel");
	await x.send("effect");
	x.harness.resume();
	await x.finish("keel.effect");
	assert.equal(runs, 1);
	assert.deepEqual((await x.state()).facts, ["1"]);
});

test("both creation and delivery resolve null cwd to the host's project directory", async (t) => {
	const x = await setup(t);
	await x.send("agent");
	const [id] = await x.agents();
	assert.ok(id);
	const worker = await x.harness.conversation(id, ctx);
	assert.equal((await worker?.agent(ctx))?.cwd, "/projects/quant-engine");
	x.provider.setResponses([publish()]);
	x.harness.resume();
	await x.finish("keel.deliver");
	assert.equal((await worker?.agent(ctx))?.cwd, "/projects/quant-engine");
});

// A queued obligation must survive either a failed blocker or an explicit abort.
for (const mode of ["failed", "queued stop"] as const)
	test(`a ${mode} run reports the still-open obligation`, {
		timeout: 5000,
	}, async (t) => {
		const x = await setup(t);
		const entered = latch<void>();
		const release = latch<void>();
		const failure = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "invalid request",
		});
		x.provider.setResponses([
			async (_, options) => {
				entered.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), {
					once: true,
				});
				await release.promise;
				return failure;
			},
			failure,
		]);
		await x.send("agent");
		x.harness.resume();
		await entered.promise;
		const [worker] = await x.agents();
		assert.ok(worker);
		await x.send("agent");
		for (let i = 0; ; i++) {
			const record = await x.harness.commit(
				(tx) => tx.submissionByRequest(worker, token("worker/0", 2)),
				ctx,
			);
			if (record?.status === "queued") break;
			assert.ok(i < 200, "replacement input did not queue");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (mode === "failed") release.resolve();
		else await (await x.harness.conversation(worker, ctx))!.abort(ctx);
		await x.finish("keel.deliver");
		assert.equal(x.provider.state.callCount, mode === "failed" ? 2 : 1);
		assert.equal((await x.state()).stalls, 1);
		assert.deepEqual((await x.state()).notes, [
			mode === "failed" ? "failed" : "stopped",
		]);
	});

test("re-entering after pause uses a fresh delivery in the same conversation", async (t) => {
	const x = await setup(t);
	x.provider.setResponses([publish(), publish()]);
	await x.send("agent");
	x.harness.resume();
	await x.finish("keel.deliver");
	const [worker] = await x.agents();
	assert.ok(worker);
	const byTurn = (n: number) =>
		x.harness.commit(
			(tx) => tx.submissionByRequest(worker, token("worker/0", n)),
			ctx,
		);
	const first = await byTurn(1);
	assert.ok(first);
	await x.send("pause");
	await x.finish("keel.stop");
	await x.send("agent", { turn: 2 });
	await x.finish("keel.deliver");
	const second = await byTurn(2);
	assert.ok(second);
	assert.notEqual(first.id, second.id);
	assert.equal((await x.state()).publications, 2);
	assert.deepEqual(await x.agents(), [worker]);
});

for (const move of ["pause", "cancel", "quiet"])
	test(`a token cannot re-enter after ${move}`, async (t) => {
		const x = await setup(t);
		await x.send("agent");
		await x.send(move);
		await assert.rejects(
			x.send("agent", { turn: 1 }),
			/reus.*token|token.*reus/i,
		);
	});

test("two designers cannot share and overwrite the work binding", async (t) => {
	const x = await setup(t);
	await x.send("ask", { basis: "designers" });
	await assert.rejects(
		x.send("agent", { count: 2 }),
		/designer|already bound/i,
	);
	assert.deepEqual(await x.agents(), []);
});

test("a refused follow-up to a fact rolls back the chain and reports the undeliverable update", async (t) => {
	const x = await setup(t);
	await x.send("ask", { basis: "bad follow-up" });
	await x.send("effect");
	x.harness.resume();
	await x.finish("keel.effect");
	assert.deepEqual((await x.state()).facts, []);
	const log = await x.harness.commit(
		async (tx) => tx.scanEntries({ conversationId: await eventLog(tx) }, 100),
		ctx,
	);
	assert.ok(
		log.items.some(
			(e) =>
				e.kind === "keel.event" &&
				["effect_done", "outside", "not allowed"].every((part) =>
					JSON.stringify(e.data).includes(part),
				),
		),
	);
});

test("a routed request cannot impersonate a kernel fact", async (t) => {
	const x = await setup(t);
	await x.send("effect_done", { key: "once", result: { value: "forged" } });
	assert.deepEqual((await x.state()).facts, []);
});

test("a stale stop cannot abort a later run just because the agent is paused again", async (t) => {
	const x = await setup(t);
	await x.send("agent");
	await x.send("pause");
	x.harness.resume();
	await x.finish("keel.stop");
	await x.send("agent", { turn: 0 }); // resumes worker 0 without any expectation
	await x.send("pause");
	await x.finish("keel.stop");
	const [id] = await x.agents();
	assert.ok(id);
	const worker = (await x.harness.conversation(id, ctx))!;
	const entered = latch<void>(),
		release = latch<void>();
	x.provider.setResponses([
		async (_, opts) => {
			entered.resolve();
			opts?.signal?.addEventListener("abort", () => release.resolve(), {
				once: true,
			});
			await release.promise;
			return fauxAssistantMessage("done");
		},
	]);
	const submission = await worker.submit(
		{ type: "input", content: "separate run" },
		ctx,
	);
	await entered.promise;
	try {
		await x.harness.commit(
			(tx) =>
				tx.createTask(
					x.k.tasks.stop,
					{
						lane: "toy",
						work: workId(x.root.id),
						conversation: id,
						key: agentKey("worker/0"),
					},
					{
						ownership: { kind: "conversation" },
						conversationId: id,
						background: true,
					},
				),
			ctx,
		);
		await x.finish("keel.stop");
	} finally {
		release.resolve();
	}
	assert.equal((await submission.wait(ctx)).status, "done");
});

test("a platform-faulted effect reports one failure and releases its running slot", {
	timeout: 3000,
}, async (t) => {
	const x = await toy({
		async runEffect() {
			return {
				get value(): string {
					throw new Error("could not read effect result");
				},
			};
		},
	});
	t.after(() => x.harness.close(ctx));
	await x.send("effect");
	const [task] = await x.tasks("keel.effect");
	assert.ok(task);
	const receipt = await x.harness.waitForTask(task.id, ctx);
	assert.equal(receipt.state.outcome.status, "faulted");
	await x.finish("keel.effect-result");
	const facts = (await x.state()).facts;
	assert.equal(facts.length, 1);
	assert.match(facts[0]!, /could not read effect result/);
	assert.deepEqual(await x.send("claimed"), { reply: "false" });
});

test("three failed effect attempts deliver one failure to the lane", async (t) => {
	let n = 0;
	const x = await setup(t, {
		runEffect: async () => {
			n++;
			throw Error("disk busy");
		},
	});
	await x.send("effect");
	x.harness.resume();
	await x.finish("keel.effect");
	assert.equal(n, 3);
	assert.deepEqual((await x.state()).facts, ["disk busy"]);
});
test("an effect removed before its first run does not act", async (t) => {
	let runs = 0;
	const x = await setup(t, {
		runEffect: async () => ({ value: String(++runs) }),
	});
	await x.send("effect");
	await x.send("cancel");
	x.harness.resume();
	await x.finish("keel.effect");
	assert.equal(runs, 0);
	assert.deepEqual((await x.state()).facts, []);
});
test("an effect runs once per key and records its result even after cancellation", async (t) => {
	const entered = latch<void>(),
		release = latch<void>();
	let runs = 0;
	const x = await setup(t, {
		runEffect: async () => {
			runs++;
			entered.resolve();
			await release.promise;
			return { value: "it happened" };
		},
	});
	await x.send("effect");
	await x.send("effect");
	assert.deepEqual(await x.send("claimed"), { reply: "false" });
	x.harness.resume();
	await entered.promise;
	assert.deepEqual(await x.send("claimed"), { reply: "true" });
	const other = await x.harness.createConversation(
		{ ownership: { kind: "ownerless" } },
		ctx,
	);
	assert.deepEqual(await x.deliver("toy", other.id, { kind: "claimed" }), {
		reply: "false",
	});
	await x.send("cancel");
	release.resolve();
	await x.finish("keel.effect");
	await x.send("effect");
	await x.finish("keel.effect");
	assert.equal(runs, 1);
	assert.deepEqual((await x.state()).facts, ["it happened"]);
	assert.deepEqual(await x.send("claimed"), { reply: "false" });
});
