import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, ToolResultMessage } from "tau/ai";
import { fauxAssistantMessage, fauxToolCall } from "tau/testing";
import { compile } from "../src/transcript.ts";

const user = (content: string): Message => ({
	role: "user",
	content,
	timestamp: 0,
});
const call = (id: string) => fauxToolCall("Run", {}, { id });
const result = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolName: "Run",
	toolCallId: id,
	isError: false,
	content: [{ type: "text", text: id }],
	timestamp: 0,
});
const system = (parameters: object): Message => ({
	role: "system",
	content: "base",
	toolsAdded: [{ name: "Run", description: "run", parameters }],
	timestamp: 0,
});

test("current tools retain nested schemas; root combinators name the offending tool", () => {
	const schema = {
		type: "object",
		properties: { v: { anyOf: [{ const: 1 }, { const: "one" }] } },
	};
	const output = compile({ messages: [system(schema), user("go")] });
	assert.ok(!("error" in output));
	assert.deepEqual(output.tools[0]?.parameters, schema);
	assert.equal(output.systemPrompt, "base");
	assert.equal(output.prompt, "go");
	for (const key of ["anyOf", "oneOf", "allOf"])
		assert.match(
			(
				compile({ messages: [system({ [key]: [] }), user("go")] }) as {
					error: string;
				}
			).error,
			/Run/,
		);
});
test("parallel results share one record before steers with collision-free matching IDs", () => {
	const ids = ["a:b", "a_b", "a_b_1"];
	const messages = [
		user("go"),
		fauxAssistantMessage(ids.map(call)),
		user("steer"),
		...ids.map(result),
	];
	const compiled = compile({ messages });
	assert.ok(!("error" in compiled));
	assert.deepEqual(compiled, compile({ messages }));
	assert.deepEqual(
		compiled.history.map((m) => m.role),
		["user", "assistant", "user", "user"],
	);
	const calls = compiled.history[1]!.content;
	const results = compiled.history[2]!.content;
	assert.ok(Array.isArray(calls) && Array.isArray(results));
	const mapped = calls.map((b) => {
		assert.ok(b.type === "tool_use");
		assert.equal(b.name, "mcp__tau__Run");
		assert.match(b.id, /^[a-zA-Z0-9_-]+$/);
		return b.id;
	});
	assert.equal(new Set(mapped).size, 3);
	assert.deepEqual(
		results.map((b) => b.type === "tool_result" && b.tool_use_id),
		mapped,
	);
	assert.equal(compiled.history[3]?.content, "steer");
	assert.match(String(compiled.prompt), /ends with the tool result/);
});
test("reject malformed histories rather than silently repairing them", () => {
	for (const messages of [
		[],
		[result("x")],
		[fauxAssistantMessage([call("x"), call("x")]), result("x")],
		[fauxAssistantMessage(call("x")), result("x"), result("x")],
		[fauxAssistantMessage(call("x")), user("go")],
	])
		assert.ok("error" in compile({ messages }));
});
test("only replay local signed thinking; discard failed turns and their results", () => {
	const thinking = {
		type: "thinking" as const,
		thinking: "reason",
		thinkingSignature: "sig",
	};
	const assistant = fauxAssistantMessage([
		thinking,
		{ type: "text", text: "ok" },
	]);
	const dropped = fauxAssistantMessage(call("bad"), { stopReason: "aborted" });
	const c = compile({
		messages: [
			user("go"),
			assistant,
			dropped,
			result("bad"),
			{ ...assistant, provider: "claude-code" },
			user("next"),
		],
	});
	assert.ok(!("error" in c));
	assert.deepEqual(
		c.history.map((m) => m.content),
		[
			"go",
			[{ type: "text", text: "ok" }],
			[
				{ type: "thinking", thinking: "reason", signature: "sig" },
				{ type: "text", text: "ok" },
			],
		],
	);
});
