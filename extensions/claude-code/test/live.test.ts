import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
	const sessions: (string | undefined)[] = [];
	const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
	let count = 0,
		fences = 0;
	t.after(() =>
		t.diagnostic(JSON.stringify({ queries: count, fences, exits })),
	);
	const provider = claudeCode({
		catalog: { getModels: () => [base] },
		query: (args) => {
			assert.ok(++count <= 7);
			sessions.push(args.options.resume ?? args.options.sessionId);
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
	const padding = Array.from(
		{ length: 384 },
		(_, i) =>
			`Reference row ${i}: amber coral lemon olive plum silver ivory; warehouse notebook compass window carpet.`,
	).join("\n");
	for (const [sequence, prompt] of [
		[
			"sequential",
			"First call add for 17+24. Wait for the result. Call add with that result and 5. Wait for the result and reply with its number only.",
		],
		["text", "Remember the word BLUE. Reply only BLUE."],
		[
			"parallel",
			"Use add for 19+23 and 71+7. Call both tools in parallel in ONE assistant message. Then report both results.",
		],
	] as const) {
		const sessionId = randomUUID();
		const messages: Message[] = [
			{
				role: "user",
				content: `${sequence === "sequential" ? sessionId + "\n" + padding + "\n" : ""}${prompt}`,
				timestamp: 0,
			},
		];
		const first = sessions.length;
		const uses: { read: number; write: number }[] = [];
		const rounds = sequence === "sequential" ? 3 : 2;
		for (let round = 0; round < rounds; round++) {
			const m = await models.completeSimple(
				model,
				{
					messages,
					tools: sequence === "text" ? [] : [tool],
					systemPrompt:
						"Follow the arithmetic fixture exactly. Keep answers terse.",
				},
				{ sessionId, timeoutMs: 60000 },
			);
			const usage = { read: m.usage.cacheRead, write: m.usage.cacheWrite };
			uses.push(usage);
			t.diagnostic(JSON.stringify({ sequence, round: round + 1, ...usage }));
			const calls = m.content.filter((b) => b.type === "toolCall");
			const toolRound = sequence !== "text" && round + 1 < rounds;
			assert.equal(
				m.stopReason,
				toolRound ? "toolUse" : "stop",
				m.errorMessage,
			);
			assert.equal(
				calls.length,
				toolRound ? (sequence === "parallel" ? 2 : 1) : 0,
			);
			messages.push(m);
			if (toolRound)
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
			else if (sequence === "text") {
				assert.match(JSON.stringify(m.content), /BLUE/);
				messages.push({
					role: "user",
					content: "Repeat the word you remembered.",
					timestamp: Date.now(),
				});
			} else if (sequence === "parallel") {
				assert.match(JSON.stringify(m.content), /42/);
				assert.match(JSON.stringify(m.content), /78/);
			} else assert.match(JSON.stringify(m.content), /46/);
		}
		assert.equal(new Set(sessions.slice(first)).size, 1);
		if (sequence === "sequential")
			for (const i of [1, 2]) {
				const prefix = uses[i - 1]!.read + uses[i - 1]!.write;
				assert.ok(
					prefix > 0 && uses[i]!.read >= prefix,
					`round ${i + 1} read ${uses[i]!.read} of ${prefix}`,
				);
			}
	}
	for (const pid of pids)
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.equal(fences, 7);
	assert.equal(exits.length, count);
	assert.ok(exits.every((e) => e.signal === null));
});
