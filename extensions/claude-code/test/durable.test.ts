import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	MemoryStorage,
	openNodeSqliteStorage,
	type Storage,
} from "tau/durable";
import { num, obj } from "tau/schema";
import { openStore } from "tau/testing";
import { failure, fakeClaudeCode, fixture } from "./fake-claude-code.ts";

const text = () => ({ frames: fixture("text") });
async function conversation(
	f: ReturnType<typeof fakeClaudeCode>,
	storage: Storage = new MemoryStorage(),
	sums: number[] = [],
) {
	const registry = createRegistry();
	const add = defineTool({
		name: "add",
		description: "add",
		parameters: obj({ a: num(), b: num() }),
		replay: "safe",
		execute: async ({ a, b }) => {
			sums.push(a + b);
			return { output: [{ type: "text", text: String(a + b) }] };
		},
	});
	const extension = defineExtension({ name: "math", tools: [add] });
	registry.install(extension);
	const { harness } = await openStore(
		storage,
		{
			registry,
			models: f.models,
			settings: {
				retry: { baseDelayMs: 1 },
				compaction: { keepRecentTokens: 1, reserveTokens: 1000 },
			},
		},
		ctx,
	);
	const root = await harness.root(ctx);
	await harness.commit(
		(tx) =>
			configure(tx, root.id, {
				model: { provider: f.model.provider, modelId: f.model.id },
				extensions: [extension],
			}),
		ctx,
	);
	harness.resume();
	return {
		harness,
		root,
		async submit(content: string) {
			await (
				await root.submit({ type: "input", content, requestId: content }, ctx)
			).wait(ctx);
			await root.waitForIdle(ctx);
		},
	};
}
test("reopened store resumes the interrupted continuation with Tau's two real results", async (t) => {
	const resuming = Promise.withResolvers<void>();
	const f = fakeClaudeCode(
		t,
		{ frames: fixture("parallel"), parked: true },
		{ frames: [], stall: true, onPrompt: resuming.resolve },
		text(),
	);
	const file = f.home + "/store.sqlite",
		sums: number[] = [];
	const a = await conversation(f, await openNodeSqliteStorage(file), sums);
	await a.root.submit(
		{ type: "input", content: "add twice", requestId: "math" },
		ctx,
	);
	await resuming.promise;
	await a.harness.close(ctx);
	const b = await conversation(f, await openNodeSqliteStorage(file), sums);
	t.after(() => b.harness.close(ctx));
	await b.root.waitForIdle(ctx);
	assert.deepEqual(sums.sort(), [42, 78]);
	assert.equal(f.requests.length, 3);
	const [first, second, replay] = f.requests;
	assert.ok(first!.trace.indexOf("interrupt") < first!.trace.indexOf("drain"));
	assert.ok(first!.trace.indexOf("drain") < first!.trace.indexOf("close"));
	assert.ok(
		!first!.trace
			.slice(0, first!.trace.indexOf("close"))
			.includes("handler settled"),
	);
	assert.equal(first!.path, second!.path);
	assert.deepEqual(second!.history.at(-1), replay!.history.at(-1));
	assert.equal(replay!.path, first!.path);
	assert.match(JSON.stringify(replay!.history), /add twice/);
	const results = replay!.history.at(-1)?.content;
	assert.ok(Array.isArray(results));
	assert.deepEqual(
		results.map((b) => (b.type === "tool_result" ? b.content : undefined)),
		["42", "78"],
	);
	assert.doesNotMatch(
		JSON.stringify(replay!.rows),
		/User rejected tool use|Request interrupted by user/,
	);
	assert.match(JSON.stringify(replay!.prompt), /ends with the tool result/);
	f.assertClean(replay!.path);
});
for (const kind of ["usage", "overload", "overflow"] as const)
	test("durable " + kind, async (t) => {
		const replies =
			kind === "usage"
				? [{ frames: failure("You've hit your usage limit (429)") }]
				: kind === "overload"
					? [{ frames: failure("overloaded") }, text()]
					: [text(), { frames: failure("prompt is too long") }, text(), text()];
		const f = fakeClaudeCode(t, ...replies);
		const c = await conversation(f);
		t.after(() => c.harness.close(ctx));
		if (kind === "overflow") await c.submit("earlier");
		await c.submit("go");
		assert.equal(f.attempts(), replies.length);
		if (kind === "overflow") {
			assert.match(
				String(f.requests[2]!.options.systemPrompt),
				/summarization/,
			);
			assert.equal(f.requests[2]!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "800");
		}
		f.assertClean(kind === "usage" ? undefined : f.requests.at(-1)!.path);
	});
