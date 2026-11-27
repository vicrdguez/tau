import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
	AccountInfo,
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	type ContentBlock,
	createSession,
	getSessionPath,
	openSession,
} from "cc-session-io";
import { createModels, fauxProvider } from "tau/testing";
import { claudeCode } from "../src/provider.ts";
import type { QueryFn } from "../src/run.ts";

export const fixture = (name: "text" | "parallel"): SDKMessage[] =>
	JSON.parse(
		readFileSync(
			new URL("./fixtures/" + name + ".json", import.meta.url),
			"utf8",
		),
	);
export const failure = (result: string): SDKMessage[] => [
	{ type: "result", subtype: "success", is_error: true, result } as SDKMessage,
];
export type Reply = {
	frames: SDKMessage[];
	account?: AccountInfo;
	stubborn?: boolean;
	stall?: boolean;
	onPrompt?: () => void;
	parked?: boolean;
	wait?: Promise<void>;
};
const login: AccountInfo = {
	apiProvider: "firstParty",
	subscriptionType: "Claude Max",
};
export function fakeClaudeCode(t: TestContext, ...replies: Reply[]) {
	const home = mkdtempSync(join(tmpdir(), "tau-cc-test-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const requests: {
		options: Options;
		history: { role: string; content: string | ContentBlock[] }[];
		rows: ReturnType<typeof openSession>["records"];
		path: string;
		pid: number;
		env: NodeJS.ProcessEnv;
		prompt?: SDKUserMessage;
		trace: string[];
	}[] = [];
	let attempts = 0;
	const started = Promise.withResolvers<void>();
	const query: QueryFn = ({ options, prompt }) => {
		attempts++;
		const reply = replies.shift();
		assert.ok(reply, "unexpected request");
		const cwd = options.cwd!,
			claudeDir = options.env!.CLAUDE_CONFIG_DIR!,
			sessionId = (options.resume ?? options.sessionId)!;
		const path = getSessionPath(sessionId, cwd, claudeDir);
		const params = { projectPath: cwd, sessionId, claudeDir };
		const file = options.resume ? openSession(params) : createSession(params);
		const history = file.messages.map(({ message: { role, content } }) => ({
			role,
			content,
		}));
		const child = options.spawnClaudeCodeProcess!({
			command: process.execPath,
			args: [
				"-e",
				`process.stdout.write(JSON.stringify(process.env));process.stdin.resume();${reply.stubborn ? 'process.on("SIGTERM",()=>{}); setInterval(()=>{},60000)' : ""}`,
			],
			cwd,
			env: {
				...options.env,
				ANTHROPIC_API_KEY: "sdk-inherited",
				CLAUDECODE: "nested",
			},
			signal: new AbortController().signal,
		});
		const req: (typeof requests)[number] = {
			options,
			history,
			rows: file.records,
			path,
			pid: (child as import("node:child_process").ChildProcess).pid!,
			env: {},
			trace: [],
		};
		requests.push(req);
		const ready = once(child.stdout!, "data").then(([data]) => {
			req.env = JSON.parse(String(data));
		});
		const pending = prompt[Symbol.asyncIterator]()
			.next()
			.then((r) => {
				if (!r.done) {
					req.prompt = r.value;
					req.trace.push("prompt");
				}
			});
		const interrupted = Promise.withResolvers<void>(),
			closed = Promise.withResolvers<void>();
		let parked: Promise<unknown> | undefined;
		return {
			accountInfo: async () => {
				await ready;
				req.trace.push("account");
				return reply.account ?? login;
			},
			initializationResult: async () => ({ account: reply.account ?? login }),
			interrupt: async () => {
				req.trace.push("interrupt");
				interrupted.resolve();
			},
			close: () => {
				req.trace.push("close");
				closed.resolve();
				child.stdin.end();
			},
			async *[Symbol.asyncIterator]() {
				await pending;
				if (!req.prompt) return;
				started.resolve();
				reply.onPrompt?.();
				await reply.wait;
				file.addUserMessage(req.prompt.message.content as string);
				file.addAttachment({ type: "fixture_context" });
				const start = reply.frames.find(
					(m) => m.type === "stream_event" && m.event.type === "message_start",
				);
				if (
					start?.type === "stream_event" &&
					start.event.type === "message_start"
				) {
					const id = start.event.message.id;
					const calls = reply.frames.flatMap((m) =>
						m.type === "stream_event" &&
						m.event.type === "content_block_start" &&
						m.event.content_block.type === "tool_use"
							? [m.event.content_block]
							: [],
					);
					const blocks: ContentBlock[] = [
						{ type: "thinking", thinking: "", signature: "test-signature" },
						...(calls.length
							? calls.map((c, i) => ({
									type: "tool_use" as const,
									id: c.id,
									name: c.name,
									input: i ? { a: 71, b: 7 } : { a: 19, b: 23 },
								}))
							: [{ type: "text" as const, text: "PROBE:BLUE" }]),
					];
					for (const block of blocks) {
						file.addAssistantMessage([block]);
						const row = file.messages.at(-1)!;
						if (row.type === "assistant") row.message.id = id;
					}
					if (calls.length) {
						file.addToolResults(
							calls.map((c) => ({
								toolUseId: c.id,
								content: "User rejected tool use",
								isError: true,
							})),
						);
						file.addAttachment({ type: "prompt_snapshot" });
						file.addUserMessage("[Request interrupted by user for tool use]");
					}
				}
				file.save();
				let client: Client | undefined;
				try {
					if (reply.parked) {
						const server = options.mcpServers!.tau;
						assert.ok(server && "instance" in server);
						const [a, b] = InMemoryTransport.createLinkedPair();
						client = new Client({ name: "fixture", version: "1" });
						await Promise.all([client.connect(a), server.instance.connect(b)]);
						assert.ok(
							(await client.listTools()).tools.some(
								(tool) => tool.name === "add",
							),
						);
						parked = client
							.callTool({ name: "add", arguments: { a: 19, b: 23 } })
							.then(
								() => req.trace.push("handler settled"),
								() => req.trace.push("handler settled"),
							);
					}
					if (reply.stall)
						await Promise.race([closed.promise, interrupted.promise]);
					else for (const m of reply.frames) yield m;
					if (reply.stall || reply.frames.at(-1)?.type !== "result") {
						await interrupted.promise;
						req.trace.push("drain");
						yield {
							type: "result",
							subtype: "error_during_execution",
							errors: ["interrupted"],
							is_error: true,
						} as SDKMessage;
					}
				} finally {
					if (client) {
						await closed.promise;
						await client.close();
						await parked;
					}
				}
			},
		};
	};
	const models = createModels();
	const source = fauxProvider({
		models: [{ id: "test", contextWindow: 500000 }],
	}).models[0];
	const newProvider = () =>
		claudeCode({
			catalog: { getModels: () => [source] },
			query,
			env: {
				HOME: home,
				CLAUDE_CONFIG_DIR: join(home, "claude"),
				ANTHROPIC_API_KEY: "parent",
				CLAUDE_CODE_USE_BEDROCK: "1",
			},
		});
	const provider = newProvider();
	models.setProvider(provider);
	const model = provider.getModels()[0]!;
	const assertClean = (kept?: string) => {
		for (const r of requests) {
			assert.throws(() => process.kill(r.pid, 0), { code: "ESRCH" });
			assert.equal(existsSync(r.path), r.path === kept);
		}
	};
	return {
		home,
		newProvider,
		attempts: () => attempts,
		models,
		model,
		provider,
		requests,
		started: started.promise,
		assertClean,
	};
}
