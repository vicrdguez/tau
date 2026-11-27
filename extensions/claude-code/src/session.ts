import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createSession,
	deleteSession,
	getProjectDir,
	type JsonlRecord,
	openSession,
	Session,
	serializeJsonl,
	type UserContentBlock,
} from "cc-session-io";
import type {
	AssistantMessage,
	Message,
	SimpleStreamOptions,
	TranscriptContext,
} from "tau/ai";
import { type Compiled, compile } from "./transcript.ts";

const { claudeCodeVersion: version }: { claudeCodeVersion: string } =
	JSON.parse(
		readFileSync(
			new URL(
				"./package.json",
				import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
			),
			"utf8",
		),
	);
type Kept = {
	sessionId: string;
	version: string;
	model: string;
	systemTools: string;
	covered: string[];
	leaf: string;
	chainHash: string;
	pending: [tau: string, claude: string][];
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function messageDigest(m: Message) {
	const { role, content } = m;
	const fields =
		role === "assistant"
			? [m.provider, m.stopReason]
			: role === "toolResult"
				? [m.toolCallId, m.toolName, m.isError]
				: role === "system"
					? [m.sections, m.toolsAdded, m.toolsRemoved]
					: [];
	return hash(
		JSON.stringify([role, content, ...fields], (_key, value) =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((k) => [k, value[k]]),
					)
				: value,
		),
	);
}
function replace(path: string, data: string) {
	const tmp = path + "." + randomUUID();
	try {
		writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}
function claim(cwd: string, options: SimpleStreamOptions) {
	if (!options.sessionId || options.cacheRetention === "none") return;
	const dir = join(cwd, "sessions"),
		path = join(dir, hash(options.sessionId));
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(
			path + ".lock",
			JSON.stringify({
				pid: process.pid,
				startedAt: new Date(Date.now() - process.uptime() * 1000),
			}),
			{ flag: "wx", mode: 0o600 },
		);
		return path;
	} catch {
		return;
	}
}
function record(path: string): Kept | undefined {
	try {
		const r = JSON.parse(readFileSync(path, "utf8"));
		// This ID also names the directory removed when the session is superseded.
		if (
			typeof r.sessionId === "string" &&
			/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.sessionId)
		)
			return r;
	} catch {
		/* No usable record. */
	}
}
function chainAt(file: Session, leaf: string) {
	const rows = file.records,
		end = rows.findLastIndex((r) => r.uuid === leaf);
	if (end < 0 || rows[end]?.type !== "assistant")
		throw new Error("Missing assistant row");
	let parent: unknown = leaf;
	const chain: JsonlRecord[] = [];
	for (let i = end; i >= 0; i--) {
		const row = rows[i]!;
		if (typeof row.uuid !== "string") chain.push(row);
		else if (row.uuid === parent) {
			chain.push(row);
			parent = row.parentUuid;
		}
	}
	if (parent !== null) throw new Error("Missing session ancestor");
	return chain.reverse();
}
function resume(
	file: Session,
	kept: Kept,
	messages: Message[],
	digests: string[],
	request: Compiled,
) {
	if (!kept.covered.length || !kept.covered.every((v, i) => digests[i] === v))
		return;
	const rest = messages.slice(kept.covered.length);
	if (
		!rest.length ||
		rest.some((m) => m.role !== "user" && m.role !== "toolResult")
	)
		return;
	const results = rest.filter((m) => m.role === "toolResult");
	const pending = new Map(kept.pending);
	if (
		results.length !== pending.size ||
		!results.every((r) => pending.has(r.toolCallId))
	)
		return;
	const chain = chainAt(file, kept.leaf);
	if (hash(serializeJsonl(chain)) !== kept.chainHash) return;
	const draft = new Session({
		sessionId: file.sessionId,
		jsonlPath: file.jsonlPath,
		projectPath: file.projectPath,
		records: chain,
		version,
	});
	// compile groups results before steers and takes the final user prompt out of history.
	const userRows = rest.filter((m) => m.role === "user").length;
	const count =
		userRows + Number(pending.size > 0) - Number(rest.at(-1)?.role === "user");
	let at = kept.leaf;
	for (const row of request.history.slice(request.history.length - count)) {
		if (row.role !== "user") return;
		const content =
			typeof row.content === "string"
				? row.content
				: (row.content.map((b, i) =>
						b.type === "tool_result"
							? { ...b, tool_use_id: pending.get(results[i]!.toolCallId)! }
							: b,
					) as UserContentBlock[]);
		at = draft.addUserMessage(content);
	}
	replace(file.jsonlPath, serializeJsonl([...draft.records]));
	return at;
}
export function prepareSession(
	env: NodeJS.ProcessEnv,
	model: string,
	options: SimpleStreamOptions,
	context: TranscriptContext,
	guidance: string,
) {
	const claudeDir =
		env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
	const cwd = join(claudeDir, "tau-work");
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	mkdirSync(getProjectDir(cwd, claudeDir), { recursive: true, mode: 0o700 });
	const params = { projectPath: cwd, cwd, claudeDir, model, version };
	const key = claim(cwd, options),
		old = key ? record(key + ".json") : undefined;
	let file = createSession(params);
	function cleanup(keep: boolean) {
		try {
			if (key && !keep) rmSync(key + ".json", { force: true });
			if (!keep) deleteSession(file.sessionId, cwd, claudeDir);
			if (old && old.sessionId !== file.sessionId)
				deleteSession(old.sessionId, cwd, claudeDir);
		} catch {
			/* Unreachable session files can be cleared while Tau is stopped. */
		} finally {
			if (key)
				try {
					rmSync(key + ".lock", { force: true });
				} catch {
					/* Later requests use throwaways until the lock is cleared. */
				}
		}
	}
	try {
		const request = compile(context);
		if ("error" in request) throw new Error(request.error);
		request.systemPrompt = request.systemPrompt
			? `${request.systemPrompt}\n\n${guidance}`
			: guidance;
		const covered = key ? context.messages.map(messageDigest) : [];
		const systemTools = hash(
			JSON.stringify([request.systemPrompt, request.tools]),
		);
		let at: string | undefined;
		if (
			old &&
			old.version === version &&
			old.model === model &&
			old.systemTools === systemTools
		) {
			try {
				const existing = openSession({ ...params, sessionId: old.sessionId });
				if (existing.sessionId === old.sessionId)
					at = resume(existing, old, context.messages, covered, request);
				if (at) file = existing;
			} catch {
				/* Rebuild from Tau if the session cannot be resumed. */
			}
		}
		if (!at) {
			file.importMessages(request.history);
			if (file.records.length)
				replace(file.jsonlPath, serializeJsonl([...file.records]));
		}
		return {
			request,
			options: {
				cwd,
				...(at
					? { resume: file.sessionId, resumeSessionAt: at }
					: request.history.length
						? { resume: file.sessionId }
						: { sessionId: file.sessionId }),
			},
			finish(message?: AssistantMessage) {
				let keep = false;
				try {
					if (!key || !message || !message.responseId) return;
					const saved = openSession({ ...params, sessionId: file.sessionId });
					const leaf = saved.messages.findLast(
						(r) =>
							r.type === "assistant" && r.message.id === message.responseId,
					)?.uuid;
					if (!leaf || saved.sessionId !== file.sessionId) return;
					const chain = chainAt(saved, leaf);
					const calls = message.content.filter((b) => b.type === "toolCall");
					const actual = saved.messages
						.filter(
							(r) =>
								r.type === "assistant" &&
								r.message.id === message.responseId &&
								chain.includes(r),
						)
						.flatMap((r) =>
							typeof r.message.content === "string"
								? []
								: r.message.content.filter((b) => b.type === "tool_use"),
						);
					if (
						calls.length !== actual.length ||
						!calls.every((c, i) => c.id === actual[i]?.id)
					)
						return;
					const next: Kept = {
						sessionId: file.sessionId,
						version,
						model,
						systemTools,
						covered: [...covered, messageDigest(message)],
						leaf,
						chainHash: hash(serializeJsonl(chain)),
						pending: calls.map((c, i) => [c.id, actual[i]!.id]),
					};
					replace(key + ".json", JSON.stringify(next));
					keep = true;
				} catch {
					/* Cache publication cannot fail the model turn. */
				} finally {
					cleanup(keep);
				}
			},
		};
	} catch (e) {
		cleanup(false);
		throw e;
	}
}
