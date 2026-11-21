import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	createRegistry,
	defineExtension,
	defineTool,
	MemoryStorage,
} from "tau/durable";
import { obj } from "tau/schema";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	openStore,
} from "tau/testing";
import {
	dispatchTool,
	fanOut,
	type DispatchJob,
	type DispatchResult,
} from "../src/dispatch/index.ts";

async function stopped(signal: AbortSignal | undefined): Promise<never> {
	assert.ok(signal);
	signal.throwIfAborted();
	return new Promise((_, reject) =>
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		}),
	);
}

const jobs = [
	{ seat: "slow", question: "first question" },
	{ seat: "quick", question: "second question" },
];
async function setup(t: TestContext, timeoutMs?: number) {
	const registry = createRegistry();
	const models = createModels();
	const parent = fauxProvider({ provider: "parent" });
	const slow = fauxProvider({ provider: "slow" });
	const quick = fauxProvider({ provider: "quick" });
	for (const p of [parent, slow, quick]) models.setProvider(p.provider);
	const recursionProbe = defineTool({
		name: "recursion_probe",
		description: "Attempt to invoke fan-out from a dispatch child",
		parameters: obj({}),
		async execute(_, api, c) {
			await fanOut(api, roster, [{ seat: "quick", question: "nested" }], c);
			return {};
		},
	});
	const probeExtension = defineExtension({
		name: "recursion",
		tools: [recursionProbe],
	});
	const roster = {
		timeoutMs,
		resolve: (_tx: unknown, _caller: unknown, { seat }: DispatchJob) => {
			const provider =
				seat === "slow" ? slow : seat === "quick" ? quick : undefined;
			return (
				provider && {
					model: {
						provider: provider.getModel().provider,
						modelId: provider.getModel().id,
					},
					extensions: [probeExtension],
					tools: [recursionProbe],
					instructions: `Instructions for ${seat}`,
				}
			);
		},
	};
	const extension = defineExtension({
		name: "independent-toy",
		tools: [dispatchTool(roster)],
	});
	registry.install(extension);
	registry.install(probeExtension);
	const { harness } = await openStore(
		new MemoryStorage(),
		{ registry, models },
		ctx,
	);
	t.after(() => harness.close(ctx));
	const root = await harness.root(ctx, {
		agent: {
			model: { provider: "parent", modelId: parent.getModel().id },
			extensions: [extension],
			maxTurns: 9,
		},
	});
	harness.resume();
	const start = async (input: DispatchJob[] = jobs) => {
		parent.setResponses([
			fauxAssistantMessage([fauxToolCall("dispatch", { jobs: input })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("parent done"),
		]);
		return root.submit({ type: "input", content: "delegate" }, ctx);
	};
	const owned = () =>
		harness.commit(async (tx) => {
			const tool = (
				await tx.scanTasks({ kind: "pi.tool", conversationId: root.id }, 10)
			).items[0];
			return tool
				? (await tx.scanConversations({ ownerTaskId: tool.id }, 10)).items
				: [];
		}, ctx);
	const result = async () => {
		await root.waitForIdle(ctx);
		const entry = (await root.entries({}, 100, undefined, ctx)).items
			.flatMap(({ model }) => model ?? [])
			.find((message) => message.role === "toolResult");
		assert.ok(entry?.role === "toolResult");
		const content = entry.content[0];
		assert.ok(content?.type === "text");
		return { error: entry.isError, text: content.text };
	};
	return { harness, root, quick, slow, start, owned, result };
}

test("toy extension injects seat models and closed tools; join keeps job order despite completion order", {
	timeout: 3000,
}, async (t) => {
	const x = await setup(t);
	const completion: string[] = [];
	x.slow.setResponses([
		async (context) => {
			const system = context.messages.filter((m) => m.role === "system");
			assert.match(JSON.stringify(system), /Instructions for slow/);
			assert.deepEqual(
				system.flatMap((m) => m.toolsAdded?.map(({ name }) => name) ?? []),
				["recursion_probe"],
			);
			await delay(75);
			completion.push("slow");
			return fauxAssistantMessage("first answer");
		},
	]);
	x.quick.setResponses([
		() => {
			completion.push("quick");
			return fauxAssistantMessage("second answer");
		},
	]);
	await x.start();
	const result = await x.result();
	assert.equal(result.error, false);
	assert.deepEqual(completion, ["quick", "slow"]);
	assert.deepEqual(
		(JSON.parse(result.text) as DispatchResult[]).map(({ seat, answer }) => [
			seat,
			answer,
		]),
		[
			["slow", "first answer"],
			["quick", "second answer"],
		],
	);
	assert.equal((await x.owned()).length, 2);
});

for (const fails of ["error", "timeout"] as const) {
	test(`a child ${fails} is joined as a failure without losing its sibling's answer`, {
		timeout: 3000,
	}, async (t) => {
		const x = await setup(t, 120);
		x.slow.setResponses([
			fails === "error"
				? fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "provider refused",
					})
				: (_, options) => stopped(options?.signal),
		]);
		x.quick.setResponses([fauxAssistantMessage("sibling answer")]);
		await x.start();
		const result = await x.result();
		assert.equal(result.error, false);
		const [failed, okay] = JSON.parse(result.text) as DispatchResult[];
		assert.equal(failed?.answer, null);
		assert.match(
			failed?.error ?? "",
			fails === "timeout" ? /timed out/i : /error|failed/i,
		);
		assert.equal(okay?.answer, "sibling answer");
	});
}

test("aborting the caller stops an owned child while it waits for a model response", {
	timeout: 3000,
}, async (t) => {
	const x = await setup(t);
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	x.slow.setResponses([
		(_, options) => {
			markStarted();
			return stopped(options?.signal);
		},
	]);
	await x.start([jobs[0]!]);
	await started;
	await x.root.abort(ctx);
	const [child] = await x.owned();
	assert.ok(child);
	const handle = await x.harness.conversation(child.id, ctx);
	assert.ok(handle);
	await handle.waitForIdle(ctx);
	const unfinished = await x.harness.commit(
		async (tx) =>
			(await tx.scanTasks({ conversationId: child.id }, 10)).items.filter(
				(task) => task.state.status !== "terminal",
			),
		ctx,
	);
	assert.deepEqual(unfinished, []);
});

test("an owned child cannot dispatch even when another tool exposes fan-out", {
	timeout: 3000,
}, async (t) => {
	const x = await setup(t);
	x.slow.setResponses([
		fauxAssistantMessage([fauxToolCall("recursion_probe", {})], {
			stopReason: "toolUse",
		}),
		({ messages }) => {
			const result = messages.find((m) => m.role === "toolResult");
			assert.ok(result?.role === "toolResult" && result.isError);
			assert.match(JSON.stringify(result.content), /child.*cannot dispatch/i);
			return fauxAssistantMessage("no nested dispatch");
		},
	]);
	await x.start([jobs[0]!]);
	assert.match((await x.result()).text, /no nested dispatch/);
	assert.equal(x.quick.state.callCount, 0);
});

for (const [name, input] of [
	["empty", []],
	["oversized", Array.from({ length: 100 }, () => jobs[0]!)],
	["unknown seat", [jobs[0]!, { seat: "unknown", question: "no" }]],
] as const) {
	test(`${name} job list is refused without starting any children`, {
		timeout: 3000,
	}, async (t) => {
		const x = await setup(t);
		await x.start([...input]);
		assert.equal((await x.result()).error, true);
		assert.deepEqual(await x.owned(), []);
	});
}
