import type {
	ContentBlock,
	Message as HistoryMessage,
	ToolResultBlock,
} from "cc-session-io";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageContent,
	type TextContent,
	type Tool,
	type TranscriptContext,
} from "tau";

const continuation =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result you were waiting for. Continue the task from there.]";
export const sdkName = (name: string) => `mcp__tau__${name}`;
type Image = {
	type: "image";
	source: {
		type: "base64";
		media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
		data: string;
	};
};
type Prompt = string | (TextContent | Image)[];
export type Compiled = {
	systemPrompt: string;
	tools: Tool[];
	history: HistoryMessage[];
	prompt: Prompt;
};
type CompileError = { error: string };

function media(
	blocks: (TextContent | ImageContent)[],
): (TextContent | Image)[] {
	return blocks.map((b) => {
		if (b.type === "text") return { type: "text", text: b.text };
		const mime = b.mimeType;
		if (
			mime !== "image/png" &&
			mime !== "image/jpeg" &&
			mime !== "image/gif" &&
			mime !== "image/webp"
		)
			throw new Error("Unsupported image type: " + mime);
		return {
			type: "image",
			source: { type: "base64", media_type: mime, data: b.data },
		};
	});
}

export function compile({
	messages,
}: Pick<TranscriptContext, "messages">): Compiled | CompileError {
	const tools = getCurrentTools(messages);
	for (const tool of tools)
		for (const key of ["anyOf", "oneOf", "allOf"])
			if (key in tool.parameters)
				return { error: `Tool ${tool.name} has unsupported root ${key}` };
	const history: HistoryMessage[] = [];
	const ids = new Map<string, string>(),
		used = new Set<string>(),
		ignored = new Set<string>();
	const pending = new Set<string>();
	let results: ToolResultBlock[] = [];
	let prompt: Prompt | undefined;
	try {
		for (const m of messages) {
			if (m.role === "system") continue;
			if (
				m.role === "assistant" &&
				(m.stopReason === "error" || m.stopReason === "aborted")
			) {
				for (const b of m.content) if (b.type === "toolCall") ignored.add(b.id);
				continue;
			}
			if (
				m.role === "toolResult" &&
				ignored.has(m.toolCallId) &&
				!pending.has(m.toolCallId)
			)
				continue;
			if (m.role === "user") {
				prompt =
					typeof m.content === "string"
						? m.content || "[empty]"
						: m.content.length
							? media(m.content)
							: "[empty]";
				history.push({ role: "user", content: prompt });
				continue;
			}
			prompt = undefined;
			if (m.role === "assistant") {
				if (pending.size)
					return { error: "Missing results for " + [...pending].join(", ") };
				const blocks: ContentBlock[] = [];
				for (const b of m.content) {
					if (b.type === "text" && b.text)
						blocks.push({ type: "text", text: b.text });
					if (
						b.type === "thinking" &&
						m.provider === "claude-code" &&
						b.thinkingSignature &&
						!b.redacted
					)
						blocks.push({
							type: "thinking",
							thinking: b.thinking,
							signature: b.thinkingSignature,
						});
					if (b.type === "toolCall") {
						if (!b.id || ids.has(b.id))
							return { error: "Duplicate or empty tool call ID: " + b.id };
						const base = b.id.replace(/[^a-zA-Z0-9_-]/g, "_");
						let id = base;
						for (let suffix = 1; used.has(id); suffix++)
							id = base + "_" + suffix;
						ids.set(b.id, id);
						used.add(id);
						pending.add(b.id);
						blocks.push({
							type: "tool_use",
							id,
							name: sdkName(b.name),
							input: b.arguments,
						});
					}
				}
				if (blocks.length) history.push({ role: "assistant", content: blocks });
				if (pending.size) {
					results = [];
					history.push({ role: "user", content: results });
				}
			} else {
				const id = ids.get(m.toolCallId);
				if (!id || !pending.delete(m.toolCallId))
					return { error: "Orphan or duplicate tool result: " + m.toolCallId };
				const blocks = media(m.content);
				const content = blocks.some((b) => b.type === "image")
					? blocks
					: blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
				results.push({
					type: "tool_result",
					tool_use_id: id,
					content:
						content ||
						(m.isError
							? "Command failed with no output"
							: `(${sdkName(m.toolName)} completed with no output)`),
					...(m.isError ? { is_error: true } : {}),
				});
			}
		}
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	if (pending.size)
		return { error: "Missing results for " + [...pending].join(", ") };
	if (prompt !== undefined) history.pop();
	else if (!history.length) return { error: "Empty Claude Code transcript" };
	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools,
		history,
		prompt: prompt ?? continuation,
	};
}
