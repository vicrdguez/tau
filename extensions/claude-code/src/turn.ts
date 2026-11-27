import type {
	SDKMessage,
	SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	ToolCall,
	Usage,
} from "tau/ai";
import { sdkName } from "./transcript.ts";

type Frame = SDKPartialAssistantMessage["event"];
type BlockFrame = Extract<
	Frame,
	{ type: "content_block_start" | "content_block_delta" | "content_block_stop" }
>;
type Buffered = { frame: BlockFrame; previous: Buffered | null };
type State = {
	message: AssistantMessage;
	tools: ReadonlyMap<string, string>;
	phase: "initial" | "streaming" | "stopped";
	open: number | null;
	json: string;
	buffered: Buffered | null;
};
type Step = {
	state: State;
	events: AssistantMessageEvent[];
	decision: "continue" | "capture" | "done" | "error";
};
export function initialTurn(
	model: Model<string>,
	tools: string[],
	timestamp: number,
): State {
	return {
		tools: new Map(tools.map((n) => [sdkName(n), n])),
		phase: "initial",
		open: null,
		json: "",
		buffered: null,
		message: {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp,
			content: [],
			stopReason: "pending",
			usage: {
				input: 0,
				output: 0,
				cacheWrite: 0,
				cacheRead: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
			},
		},
	};
}
const next = (state: State, ...events: AssistantMessageEvent[]): Step => ({
	state,
	events,
	decision: "continue",
});
const fail = (state: State, errorMessage: string): Step => ({
	state: {
		...state,
		message: { ...state.message, stopReason: "error", errorMessage },
	},
	events: [],
	decision: "error",
});
export function failureText(text: string, fallback = text): string {
	if (
		/authenticat|invalid api[ _]key|not logged in|not signed in|login required|\b40[13]\b|oauth_org|cloud_credential|account_on_hold|verification_required|please run .*login/i.test(
			text,
		)
	)
		return "Claude Code is not logged in with a Claude subscription";
	if (/billing|credit balance|out of extra usage/i.test(text))
		return "Claude Code billing is unavailable on this account";
	if (/usage limit|hit your .*limit|quota exceeded|plan limit/i.test(text))
		return "Claude subscription quota exceeded";
	if (/prompt (?:is )?too long|request_too_large/i.test(text))
		return "Claude Code: prompt is too long";
	if (/\b5\d\d\b|server_error/i.test(text))
		return "Claude Code server error: " + text;
	return fallback;
}
type Counts = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
	cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
};
function usage(old: Usage, count: Counts): Usage {
	const input = count.input_tokens ?? old.input,
		output = count.output_tokens ?? old.output,
		cacheWrite = count.cache_creation_input_tokens ?? old.cacheWrite,
		cacheRead = count.cache_read_input_tokens ?? old.cacheRead;
	const reasoning = count.output_tokens_details?.thinking_tokens,
		oneHour = count.cache_creation?.ephemeral_1h_input_tokens;
	return {
		...old,
		input,
		output,
		cacheWrite,
		cacheRead,
		totalTokens: input + output + cacheWrite + cacheRead,
		...(reasoning != null ? { reasoning } : {}),
		...(oneHour != null ? { cacheWrite1h: oneHour } : {}),
	};
}
function block(s: State, e: BlockFrame): Step {
	const index = e.index,
		old = s.message.content;
	const update = (b: AssistantMessage["content"][number]) => ({
		...s.message,
		content: [...old.slice(0, index), b],
	});
	if (e.type === "content_block_start") {
		if (s.open !== null || index !== old.length)
			return fail(s, "Incomplete or out-of-order Claude Code block");
		const b = e.content_block;
		if (b.type === "text" || b.type === "thinking") {
			const partial = update(
				b.type === "text"
					? { type: "text", text: b.text }
					: {
							type: "thinking",
							thinking: b.thinking,
							...(b.signature ? { thinkingSignature: b.signature } : {}),
						},
			);
			return next(
				{ ...s, message: partial, open: index },
				{
					type: b.type === "text" ? "text_start" : "thinking_start",
					contentIndex: index,
					partial,
				},
			);
		}
		if (b.type !== "tool_use")
			return fail(s, "Unsupported Claude Code block: " + b.type);
		const name = s.tools.get(b.name);
		if (
			!name ||
			!b.id ||
			old.some((c) => c.type === "toolCall" && c.id === b.id)
		)
			return fail(s, "Unknown tool or duplicate Claude Code call: " + b.name);
		const args = b.input;
		if (!args || typeof args !== "object" || Array.isArray(args))
			return fail(s, "Expected a JSON object for " + name);
		const partial = update({
			type: "toolCall",
			id: b.id,
			name,
			arguments: args as ToolCall["arguments"],
		});
		return next(
			{ ...s, message: partial, open: index, json: "" },
			{ type: "toolcall_start", contentIndex: index, partial },
		);
	}
	const b = old[index];
	if (!b || s.open !== index)
		return fail(s, "Unmatched Claude Code block event");
	if (e.type === "content_block_delta") {
		const d = e.delta;
		if (b.type === "toolCall" && d.type === "input_json_delta")
			return next(
				{ ...s, json: s.json + d.partial_json },
				{
					type: "toolcall_delta",
					delta: d.partial_json,
					partial: s.message,
					contentIndex: index,
				},
			);
		if (b.type === "thinking" && d.type === "signature_delta")
			return next({
				...s,
				message: update({
					...b,
					thinkingSignature: (b.thinkingSignature ?? "") + d.signature,
				}),
			});
		if (b.type === "thinking" && d.type === "thinking_delta") {
			const partial = update({ ...b, thinking: b.thinking + d.thinking });
			return next(
				{ ...s, message: partial },
				{
					type: "thinking_delta",
					partial,
					contentIndex: index,
					delta: d.thinking,
				},
			);
		}
		if (b.type === "text" && d.type === "text_delta") {
			const partial = update({ ...b, text: b.text + d.text });
			return next(
				{ ...s, message: partial },
				{ type: "text_delta", partial, contentIndex: index, delta: d.text },
			);
		}
		return fail(s, "Unexpected Claude Code block delta: " + d.type);
	}
	const state = { ...s, open: null };
	if (b.type === "text")
		return next(state, {
			type: "text_end",
			contentIndex: index,
			content: b.text,
			partial: s.message,
		});
	if (b.type === "thinking")
		return next(state, {
			type: "thinking_end",
			contentIndex: index,
			content: b.thinking,
			partial: s.message,
		});
	try {
		const args = s.json ? JSON.parse(s.json) : b.arguments;
		if (!args || typeof args !== "object" || Array.isArray(args))
			return fail(s, "Expected a JSON object for " + b.name);
		const toolCall: ToolCall = { ...b, arguments: args },
			partial = update(toolCall);
		return next(
			{ ...state, message: partial },
			{ type: "toolcall_end", toolCall, contentIndex: index, partial },
		);
	} catch {
		return fail(s, "Invalid JSON for " + b.name);
	}
}
export function step(s: State, m: SDKMessage): Step {
	if (
		m.type === "rate_limit_event" &&
		m.rate_limit_info.status === "rejected" &&
		!m.rate_limit_info.isUsingOverage
	)
		return fail(s, "Claude subscription quota exceeded");
	if (m.type === "assistant" && m.error)
		return fail(
			s,
			failureText(
				[
					m.error,
					...m.message.content.flatMap((b) =>
						b.type === "text" ? [b.text] : [],
					),
				].join(": "),
			),
		);
	if (m.type === "result") {
		if (m.subtype !== "success" || m.is_error)
			return fail(
				s,
				failureText(m.subtype === "success" ? m.result : m.errors.join("; ")),
			);
		return s.phase === "stopped"
			? { state: s, decision: "done", events: [] }
			: fail(s, "Claude Code stream ended before message_stop");
	}
	if (m.type !== "stream_event" || m.parent_tool_use_id) return next(s);
	const e = m.event;
	if (e.type === "message_start") {
		if (s.phase !== "initial")
			return fail(s, "Unexpected second Claude Code message");
		const partial = {
			...s.message,
			responseId: e.message.id,
			usage: usage(s.message.usage, e.message.usage),
		};
		return next(
			{ ...s, phase: "streaming", message: partial },
			{ type: "start", partial },
		);
	}
	if (s.phase !== "streaming")
		return fail(s, "Unexpected Claude Code event outside message");
	if (e.type === "message_delta")
		return next({
			...s,
			message: {
				...s.message,
				...(e.delta.stop_reason ? { rawStopReason: e.delta.stop_reason } : {}),
				usage: usage(s.message.usage, e.usage),
			},
		});
	if (e.type !== "message_stop") {
		if (
			s.buffered ||
			(e.type === "content_block_start" && e.content_block.type === "tool_use")
		)
			return next({ ...s, buffered: { frame: e, previous: s.buffered } });
		return block(s, e);
	}
	if (s.open !== null) return fail(s, "Incomplete Claude Code content block");
	const reason = s.message.rawStopReason;
	if (s.buffered) {
		if (reason !== "tool_use")
			return fail(s, "Incomplete Claude Code tool batch");
		const frames: BlockFrame[] = [];
		for (let p: Buffered | null = s.buffered; p; p = p.previous)
			frames.push(p.frame);
		const events: AssistantMessageEvent[] = [];
		let state: State = { ...s, buffered: null };
		for (const f of frames.reverse()) {
			const r = block(state, f);
			if (r.decision === "error") return fail(s, r.state.message.errorMessage!);
			state = r.state;
			events.push(...r.events);
		}
		if (state.open !== null)
			return fail(s, "Incomplete Claude Code tool block");
		return {
			state: {
				...state,
				phase: "stopped",
				message: { ...state.message, stopReason: "toolUse" },
			},
			events,
			decision: "capture",
		};
	}
	const stopReason =
		reason === "max_tokens"
			? "length"
			: ["end_turn", "stop_sequence", "pause_turn"].includes(reason ?? "")
				? "stop"
				: null;
	return stopReason
		? next({ ...s, phase: "stopped", message: { ...s.message, stopReason } })
		: fail(s, "Claude Code stopped with " + reason);
}
