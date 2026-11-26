import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AccountInfo,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
	query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createSession, deleteSession, getProjectDir } from "cc-session-io";
import {
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type TranscriptContext,
} from "tau/ai";
import { type Compiled, compile } from "./transcript.ts";
import { failureText, initialTurn, step } from "./turn.ts";

type Query = AsyncIterable<SDKMessage> & {
	accountInfo(): Promise<AccountInfo>;
	initializationResult(): Promise<{ account: AccountInfo }>;
	interrupt(): Promise<unknown>;
	close(): void;
};
export type QueryFn = (args: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => Query;
export type RunDeps = { query?: QueryFn; env?: NodeJS.ProcessEnv };
const { claudeCodeVersion }: { claudeCodeVersion: string } = JSON.parse(
	readFileSync(
		new URL(
			"./package.json",
			import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
		),
		"utf8",
	),
);
const grace = 5000;
const workdirGuidance =
	"The working directory in your environment information belongs to the model runtime, not to this project. Tools run in the project's working directory, so use paths relative to it.";
function childEnv(
	source: NodeJS.ProcessEnv,
	maxTokens?: number,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"HOME",
		"USER",
		"LOGNAME",
		"PATH",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"CLAUDE_CONFIG_DIR",
		"SSL_CERT_FILE",
		"NODE_EXTRA_CA_CERTS",
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"NO_PROXY",
	])
		if (source[key] !== undefined) env[key] = source[key];
	return {
		...env,
		ENABLE_CLAUDEAI_MCP_SERVERS: "0",
		DISABLE_AUTO_COMPACT: "1",
		CLAUDE_CODE_ELEGANT_MEADOW: "0",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
		CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
		CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "16384",
		...(maxTokens !== undefined
			? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) }
			: {}),
	};
}
function prepareSession(
	history: Compiled["history"],
	model: string,
	env: NodeJS.ProcessEnv,
) {
	const claudeDir =
			env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"),
		cwd = join(claudeDir, "tau-work");
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	mkdirSync(getProjectDir(cwd, claudeDir), { recursive: true, mode: 0o700 });
	const session = createSession({
		projectPath: cwd,
		cwd,
		claudeDir,
		model,
		version: claudeCodeVersion,
	});
	const dispose = () => deleteSession(session.sessionId, cwd, claudeDir);
	try {
		session.importMessages(history);
		session.save();
	} catch (error) {
		dispose();
		throw error;
	}
	return {
		options: {
			cwd,
			...(history.length
				? { resume: session.sessionId }
				: { sessionId: session.sessionId }),
		},
		dispose,
	};
}
function parkingServer(tools: Tool[], closed: Promise<void>) {
	const instance = new McpServer(
		{ name: "tau", version: "1" },
		{ capabilities: { tools: {} } },
	);
	instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(({ name, description, parameters }) => ({
			name,
			description,
			inputSchema: parameters,
		})),
	}));
	instance.server.setRequestHandler(CallToolRequestSchema, async () => {
		await closed;
		return { content: [], isError: true };
	});
	return { type: "sdk" as const, name: "tau", instance };
}
function until<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		pending
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
type Spawn = NonNullable<Options["spawnClaudeCodeProcess"]>;

async function withChild<T>(
	env: NodeJS.ProcessEnv,
	body: (spawnClaude: Spawn) => Promise<T>,
): Promise<T> {
	let processHandle:
		| { child: ChildProcessWithoutNullStreams; exit: Promise<void> }
		| undefined;
	let closing = false;
	try {
		return await body((o) => {
			if (closing || processHandle)
				throw new Error("Claude Code request cannot spawn a second child");
			const child = spawn(o.command, o.args, {
				cwd: o.cwd,
				env,
				signal: o.signal,
				stdio: "pipe",
			});
			child.stderr.resume();
			const exit = new Promise<void>((resolve) =>
				child.once("close", () => resolve()),
			);
			processHandle = { child, exit };
			return child;
		});
	} finally {
		closing = true;
		if (processHandle) {
			const { child, exit } = processHandle;
			await until(exit, AbortSignal.timeout(grace)).catch(async () => {
				child.kill("SIGKILL");
				await exit;
			});
		}
	}
}

async function drain(
	query: Query,
	iterator: AsyncIterator<SDKMessage>,
	pending: Promise<IteratorResult<SDKMessage>> | undefined,
) {
	await query.interrupt();
	for (;;) {
		const item = await (pending ?? iterator.next());
		pending = undefined;
		if (item.done) throw new Error("Missing Claude Code interruption result");
		if (item.value.type === "result") {
			if (
				item.value.is_error &&
				item.value.subtype !== "error_during_execution"
			)
				throw new Error("Claude Code failed during interruption");
			return;
		}
	}
}

type Decision = ReturnType<typeof step>["decision"];
async function oneTurn(
	queryFn: QueryFn,
	options: Options,
	request: Compiled,
	signal: AbortSignal,
	receive: (message: SDKMessage) => Decision,
) {
	const gate = Promise.withResolvers<boolean>(),
		closed = Promise.withResolvers<void>();
	async function* input(): AsyncGenerator<SDKUserMessage> {
		if (!(await gate.promise) || signal.aborted) return;
		yield {
			type: "user",
			message: { role: "user", content: request.prompt },
			parent_tool_use_id: null,
		};
		await closed.promise;
	}
	const query = queryFn({
		prompt: input(),
		options: {
			...options,
			systemPrompt: request.systemPrompt
				? `${request.systemPrompt}\n\n${workdirGuidance}`
				: workdirGuidance,
			settingSources: [],
			settings: { includeGitInstructions: false },
			tools: [],
			strictMcpConfig: true,
			includePartialMessages: true,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			mcpServers: { tau: parkingServer(request.tools, closed.promise) },
		},
	});
	let iterator: AsyncIterator<SDKMessage> | undefined;
	try {
		iterator = query[Symbol.asyncIterator]();
		let pending: Promise<IteratorResult<SDKMessage>> | undefined =
			iterator.next();
		void pending.catch(() => {});
		const [account, init] = await until(
			Promise.all([query.accountInfo(), query.initializationResult()]),
			signal,
		);
		if (
			![account, init.account].every(
				(a) =>
					a.apiProvider === "firstParty" &&
					a.subscriptionType?.trim() &&
					!/^api\b/i.test(a.subscriptionType) &&
					(!a.apiKeySource || a.apiKeySource === "none"),
			)
		)
			throw new Error(
				"Claude Code is not logged in with a Claude subscription",
			);
		signal.throwIfAborted();
		gate.resolve(true);
		let drained = false;
		let result = false,
			decision: Decision = "continue";
		try {
			do {
				const item = await until(pending, signal);
				pending = undefined;
				if (item.done)
					throw new Error("Claude Code stream ended without a result");
				result = item.value.type === "result";
				decision = receive(item.value);
				if (decision === "continue") pending = iterator.next();
			} while (pending);
		} finally {
			if (!result)
				try {
					await until(
						drain(query, iterator, pending),
						AbortSignal.timeout(grace),
					);
					drained = true;
				} catch {
					/* Close and reap even if the child no longer responds. */
				}
		}
		if (decision === "capture" && !drained)
			throw new Error("Claude Code stream was interrupted before tool handoff");
	} finally {
		gate.resolve(false);
		try {
			query.close();
		} finally {
			closed.resolve();
			void iterator?.return?.().catch(() => {});
		}
	}
}

export function run(
	deps: RunDeps,
	model: Model<string>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
	thinking: Pick<Options, "thinking" | "effort">,
) {
	const stream = createAssistantMessageEventStream();
	let state = initialTurn(model, [], Date.now());
	void execute().catch((error) => {
		const reason = options.signal?.aborted ? "aborted" : "error";
		const message = {
			...state.message,
			stopReason: reason,
			errorMessage:
				reason === "aborted"
					? "Claude Code request aborted"
					: error instanceof Error
						? error.message
						: String(error),
		} as const;
		stream.push({ type: "error", reason, error: message });
		stream.end();
	});
	return stream;
	async function execute() {
		const deadline = AbortSignal.timeout(options.timeoutMs ?? 600000),
			signal = options.signal
				? AbortSignal.any([options.signal, deadline])
				: deadline;
		signal.throwIfAborted();
		const request = compile(context);
		if ("error" in request) throw new Error(request.error);
		state = initialTurn(
			model,
			request.tools.map((t) => t.name),
			state.message.timestamp,
		);
		const env = childEnv(deps.env ?? process.env, options.maxTokens),
			session = prepareSession(request.history, model.id, env);
		let captured: ReturnType<typeof step> | undefined;
		try {
			await withChild(env, (spawnClaudeCodeProcess) =>
				oneTurn(
					deps.query ?? sdkQuery,
					{
						...session.options,
						...thinking,
						env,
						model: model.id,
						spawnClaudeCodeProcess,
					},
					request,
					signal,
					(message) => {
						const update = step(state, message);
						if (update.decision === "capture") captured = update;
						else {
							state = update.state;
							for (const event of update.events) stream.push(event);
						}
						return update.decision;
					},
				),
			);
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			if (deadline.aborted) throw new Error("Claude Code request timed out");
			throw new Error(
				failureText(detail, "Claude Code process terminated: " + detail),
			);
		} finally {
			session.dispose();
		}
		signal.throwIfAborted();
		const message = (captured?.state ?? state).message;
		if (message.stopReason === "error") throw new Error(message.errorMessage);
		if (
			message.stopReason !== "stop" &&
			message.stopReason !== "toolUse" &&
			message.stopReason !== "length"
		)
			throw new Error("Claude Code ended without a completed turn");
		for (const event of captured?.events ?? []) stream.push(event);
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end();
	}
}
