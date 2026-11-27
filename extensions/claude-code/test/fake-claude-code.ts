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
import { getSessionPath, openSession } from "cc-session-io";
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
		history: unknown[];
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
		const history = options.resume
			? openSession({ projectPath: cwd, sessionId, claudeDir }).messages.map(
					({ message: { role, content } }) => ({ role, content }),
				)
			: [];
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
	const provider = claudeCode({
		catalog: { getModels: () => [source] },
		query,
		env: {
			HOME: home,
			CLAUDE_CONFIG_DIR: join(home, "claude"),
			ANTHROPIC_API_KEY: "parent",
			CLAUDE_CODE_USE_BEDROCK: "1",
		},
	});
	models.setProvider(provider);
	const model = provider.getModels()[0]!;
	const assertClean = () => {
		for (const r of requests) {
			assert.throws(() => process.kill(r.pid, 0), { code: "ESRCH" });
			assert.equal(existsSync(r.path), false);
		}
	};
	return {
		home,
		attempts: () => attempts,
		models,
		model,
		provider,
		requests,
		started: started.promise,
		assertClean,
	};
}
