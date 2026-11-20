import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	MemoryStorage,
	type TaskId,
	type ToolRegistration,
} from "tau/durable";
import { obj } from "tau/schema";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	openStore,
} from "tau/testing";

function latch<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { resolve, reject, promise };
}
const Probe = defineDoc<{ text: string }>({
	kind: "probe.receipt",
	scope: "task",
	version: 1,
	initial: () => ({ text: "" }),
	checkpointWhen: () => false,
});
async function setup(tools: ToolRegistration[] = []) {
	const registry = createRegistry();
	const ext = defineExtension({ name: "probe", tools });
	registry.install(ext);
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	const { harness } = await openStore(
		new MemoryStorage(),
		{ registry, models },
		ctx,
	);
	const root = await harness.root(ctx, {
		agent: {
			extensions: [ext],
			model: { provider: "faux", modelId: "faux-1" },
		},
	});
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("probe", {})], {
			stopReason: "toolUse",
		}),
	]);
	return { harness, root };
}
test("a pi.tool task owns a readable receipt until it reaches terminal", async (t) => {
	const ready = latch<TaskId>();
	const release = latch<void>();
	const tool = defineTool({
		name: "probe",
		description: "probe",
		parameters: obj({}),
		execute: async (_, api, c) => {
			await api.commit(async (tx) => {
				(await tx.doc(Probe, api.taskId)).text = "published";
			}, c);
			ready.resolve(api.taskId);
			await release.promise;
			return { control: { terminate: true } };
		},
	});
	const { harness, root } = await setup([tool]);
	t.after(() => harness.close(ctx));
	harness.resume();
	await root.submit({ type: "input", content: "go" }, ctx);
	const id = await ready.promise;
	try {
		assert.deepEqual(await harness.snapshot(Probe, id, ctx), {
			text: "published",
		});
	} finally {
		release.resolve();
	}
	await harness.waitForTask(id, ctx);
	assert.equal(await harness.snapshot(Probe, id, ctx), undefined);
});
test("requestId returns the first submission for identical and different input", async (t) => {
	const { harness, root } = await setup();
	t.after(() => harness.close(ctx));
	const submit = (content: string) =>
		root.submit({ type: "input", requestId: "token", content }, ctx);
	const first = await submit("first");
	assert.equal((await submit("first")).id, first.id);
	assert.equal((await submit("changed")).id, first.id);
});
test("api.commit cannot publish after the tool invocation is aborted, even with an uncancelled context", async (t) => {
	const ready = latch<void>();
	const attempted = latch<void>();
	const tool = defineTool({
		name: "probe",
		description: "probe",
		parameters: obj({}),
		execute: async (_, api, c) => {
			const cancelled = new Promise<void>((resolve) =>
				c.abortSignal!.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			ready.resolve();
			await cancelled;
			try {
				await assert.rejects(
					api.commit(async (tx) => {
						(await tx.doc(Probe, api.taskId)).text = "late";
					}, ctx),
				);
				attempted.resolve();
			} catch (e) {
				attempted.reject(e);
			}
			return {};
		},
	});
	const { harness, root } = await setup([tool]);
	t.after(() => harness.close(ctx));
	harness.resume();
	await root.submit({ type: "input", content: "go" }, ctx);
	await ready.promise;
	await root.abort(ctx);
	await attempted.promise;
});
