import assert from "node:assert/strict";
import { test } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message, Tool } from "tau/ai";
import { createModels, fauxProvider } from "tau/testing";
import { claudeCode } from "../src/provider.ts";

test("bundled Claude Code subscription smoke", {
	skip:
		process.env.CLAUDE_CODE_LIVE !== "1" || !process.argv.includes("--live"),
}, async (t) => {
	const id = "claude-haiku-4-5";
	const base = fauxProvider({ models: [{ id }] }).models[0];
	const pids: number[] = [];
	const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
	let count = 0,
		fences = 0;
	t.after(() =>
		t.diagnostic(JSON.stringify({ queries: count, fences, exits })),
	);
	const provider = claudeCode({
		catalog: { getModels: () => [base] },
		query: (args) => {
			assert.ok(++count <= 5);
			const spawn = args.options.spawnClaudeCodeProcess!;
			const q = query({
				...args,
				options: {
					...args.options,
					spawnClaudeCodeProcess: (o) => {
						const child = spawn(o);
						child.once("exit", (code, signal) => exits.push({ code, signal }));
						pids.push(
							(child as import("node:child_process").ChildProcess).pid!,
						);
						return child;
					},
				},
			});
			return {
				accountInfo: async () => {
					const a = await q.accountInfo();
					t.diagnostic(
						JSON.stringify({
							apiProvider: a.apiProvider,
							subscriptionType: a.subscriptionType,
						}),
					);
					return a;
				},
				initializationResult: () => q.initializationResult(),
				interrupt: () => q.interrupt(),
				close: () => q.close(),
				async *[Symbol.asyncIterator]() {
					for await (const m of q) {
						if (m.type === "system" && m.subtype === "init")
							assert.equal(m.claude_code_version, "2.1.321");
						if (m.type === "stream_event" && m.event.type === "message_stop")
							fences++;
						yield m;
					}
				},
			};
		},
	});
	const models = createModels();
	models.setProvider(provider);
	const model = provider.getModels()[0]!;
	const tool: Tool = {
		name: "add",
		description: "Add two integers.",
		parameters: {
			type: "object",
			properties: { a: { type: "integer" }, b: { type: "integer" } },
			required: ["a", "b"],
		},
	};
	for (const [n, prompt] of [
		[0, "Reply only BLUE."],
		[1, "Use add once for 19+23. Then report the result."],
		[
			2,
			"Use add for 19+23 and 71+7. Call both tools in parallel in ONE assistant message. Then report both results.",
		],
	] as const) {
		const messages: Message[] = [
			{ role: "user", content: prompt, timestamp: Date.now() },
		];
		const ask = () =>
			models.completeSimple(
				model,
				{
					messages,
					tools: n ? [tool] : [],
					systemPrompt:
						"Follow the arithmetic fixture exactly. Keep answers terse.",
				},
				{ timeoutMs: 60000 },
			);
		const m = await ask();
		assert.equal(m.stopReason, n ? "toolUse" : "stop", m.errorMessage);
		const calls = m.content.filter((b) => b.type === "toolCall");
		assert.equal(calls.length, n);
		if (n) {
			messages.push(m);
			for (const c of calls) {
				assert.equal(c.name, "add");
				messages.push({
					role: "toolResult",
					toolName: c.name,
					toolCallId: c.id,
					content: [
						{
							type: "text",
							text: String(Number(c.arguments.a) + Number(c.arguments.b)),
						},
					],
					isError: false,
					timestamp: Date.now(),
				});
			}
			const final = await ask();
			assert.equal(final.stopReason, "stop", final.errorMessage);
			assert.match(JSON.stringify(final.content), /42/);
			if (n === 2) assert.match(JSON.stringify(final.content), /78/);
		} else assert.match(JSON.stringify(m.content), /BLUE/);
	}
	for (const pid of pids)
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.equal(fences, 5);
	assert.equal(exits.length, count);
	assert.ok(exits.every((e) => e.signal === null));
});
