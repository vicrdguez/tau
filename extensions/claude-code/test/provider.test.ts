import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";
import { fauxProvider } from "tau/testing";
import { claudeCode } from "../src/provider.ts";
import { fakeClaudeCode, fixture } from "./fake-claude-code.ts";

const context = {
	messages: [
		{ role: "user" as const, content: "remember", timestamp: 0 },
		{ role: "user" as const, content: "go", timestamp: 1 },
	],
};
test("catalog rereads Anthropic aliases; subscription cost is zero", () => {
	const base = fauxProvider().models[0];
	let id = "old";
	const p = claudeCode({
		catalog: {
			getModels: (provider) => {
				assert.equal(provider, "anthropic");
				return [id, id + "-20251101"].map((id) => ({
					...base,
					id,
					contextWindow: 1000000,
				}));
			},
		},
	});
	for (id of ["first", "second"]) {
		const models = p.getModels();
		assert.equal(models.length, 1);
		assert.deepEqual(
			[
				models[0]!.provider,
				models[0]!.api,
				models[0]!.id,
				models[0]!.contextWindow,
			],
			["claude-code", "claude-code", id, 200000],
		);
		assert.deepEqual(Object.values(models[0]!.cost), [0, 0, 0, 0]);
	}
});
test("authenticated text turn reports final usage and cleans up before publication", async (t) => {
	const f = fakeClaudeCode(t, { frames: fixture("text") });
	const stream = f.models.streamSimple(f.model, context, { maxTokens: 154 });
	const events = [];
	for await (const event of stream) events.push(event);
	const m = await stream.result();
	assert.equal(m.stopReason, "stop", m.errorMessage);
	f.assertClean();
	assert.deepEqual(
		events.map((e) => e.type),
		[
			"start",
			"thinking_start",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		],
	);
	assert.deepEqual(m.content.at(-1), { type: "text", text: "PROBE:BLUE" });
	assert.deepEqual(
		[m.usage.input, m.usage.output, m.usage.totalTokens, m.usage.cost.total],
		[1223, 109, 1332, 0],
	);
	const r = f.requests[0]!;
	assert.equal(statSync(r.options.cwd!).mode & 0o777, 0o700);
	assert.ok(r.trace.indexOf("account") < r.trace.indexOf("prompt"));
	assert.equal(r.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "154");
	for (const k of [
		"ANTHROPIC_API_KEY",
		"CLAUDECODE",
		"CLAUDE_CODE_USE_BEDROCK",
	])
		assert.ok(!(k in r.env));
	assert.equal(r.env.DISABLE_AUTO_COMPACT, "1");
	assert.deepEqual(r.options.tools, []);
	assert.deepEqual(r.options.settingSources, []);
	assert.equal(r.options.strictMcpConfig, true);
	assert.deepEqual(r.options.thinking, { type: "disabled" });
});
for (const [name, systemPrompt, prefix] of [
	["nonempty", "Project instructions.", "Project instructions.\n\n"],
	["empty", "", ""],
] as const)
	test(`adds project-relative path guidance when the Tau prompt is ${name}`, async (t) => {
		const f = fakeClaudeCode(t, { frames: fixture("text") });
		const m = await f.models.completeSimple(f.model, {
			messages: [
				{ role: "system", content: systemPrompt, timestamp: 0 },
				...context.messages,
			],
		});
		assert.equal(m.stopReason, "stop", m.errorMessage);
		assert.equal(
			f.requests[0]?.options.systemPrompt,
			`${prefix}The working directory in your environment information belongs to the model runtime, not to this project. Tools run in the project's working directory, so use paths relative to it.`,
		);
	});
for (const account of [
	{ apiProvider: "firstParty" as const },
	{ apiProvider: "bedrock" as const, subscriptionType: "Max" },
])
	test("refuse " + JSON.stringify(account) + " before prompt", async (t) => {
		const f = fakeClaudeCode(t, { frames: [], account });
		const m = await f.models.completeSimple(f.model, context);
		assert.equal(m.stopReason, "error");
		assert.match(m.errorMessage!, /Claude subscription/);
		assert.equal(f.requests[0]!.prompt, undefined);
		f.assertClean();
	});
test("abort before spawn", async (t) => {
	const f = fakeClaudeCode(t);
	const m = await f.models.completeSimple(f.model, context, {
		signal: AbortSignal.abort(),
	});
	assert.equal(m.stopReason, "aborted");
	assert.equal(f.requests.length, 0);
});
for (const mode of ["abort", "deadline", "kill"] as const)
	test("tears down a stalled request: " + mode, async (t) => {
		const f = fakeClaudeCode(t, {
			frames: [],
			stall: true,
			stubborn: mode === "kill",
		});
		const ac = new AbortController();
		const done = f.models.completeSimple(f.model, context, {
			signal: ac.signal,
			timeoutMs: mode === "deadline" ? 350 : 20000,
		});
		await f.started;
		if (mode !== "deadline") ac.abort();
		const m = await done;
		assert.equal(m.stopReason, mode === "deadline" ? "error" : "aborted");
		if (mode === "deadline") assert.match(m.errorMessage!, /timed out/i);
		f.assertClean();
	});
