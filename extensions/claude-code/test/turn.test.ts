import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fauxProvider } from "tau/testing";
import { initialTurn, step } from "../src/turn.ts";

const frames = () =>
	JSON.parse(
		readFileSync(new URL("./fixtures/parallel.json", import.meta.url), "utf8"),
	);
const initial = () => initialTurn(fauxProvider().models[0], ["add"], 0);
test("no tool call is visible until message_stop admits both", () => {
	let state = initial();
	for (const m of frames()) {
		const next = step(state, m);
		state = next.state;
		if (m.event.type === "message_stop") {
			assert.equal(next.decision, "capture");
			assert.deepEqual(
				next.events
					.filter((e) => e.type === "toolcall_end")
					.map((e) => e.toolCall.arguments),
				[
					{ a: 19, b: 23 },
					{ a: 71, b: 7 },
				],
			);
		} else {
			assert.equal(next.decision, "continue");
			assert.ok(next.events.every((e) => !e.type.startsWith("toolcall")));
			assert.ok(!state.message.content.some((b) => b.type === "toolCall"));
		}
	}
});
for (const kind of [
	"bad JSON",
	"unknown name",
	"duplicate ID",
	"truncated block",
])
	test(kind + " rejects the entire batch", () => {
		const messages = frames();
		const second = messages.find((m: any) => m.event.index === 2);
		if (kind === "bad JSON")
			messages.find(
				(m: any) => m.event.index === 2 && m.event.delta,
			).event.delta.partial_json = "{";
		if (kind === "unknown name")
			second.event.content_block.name = "mcp__other__add";
		if (kind === "duplicate ID")
			second.event.content_block.id = messages.find(
				(m: any) => m.event.index === 1,
			).event.content_block.id;
		if (kind === "truncated block")
			messages.splice(
				messages.findIndex(
					(m: any) =>
						m.event.index === 2 && m.event.type === "content_block_stop",
				),
				1,
			);
		let state = initial(),
			decision;
		for (const m of messages) {
			const next = step(state, m);
			state = next.state;
			decision = next.decision;
			assert.ok(next.events.every((e) => !e.type.startsWith("toolcall")));
			if (decision === "error") break;
		}
		assert.equal(decision, "error");
		assert.ok(!state.message.content.some((b) => b.type === "toolCall"));
	});
for (const [raw, match] of [
	["invalid API key (500)", /subscription|login/i],
	["billing_error: overloaded", /billing/i],
	["prompt is too long", /prompt is too long/i],
	["You've hit your limit", /quota exceeded/i],
	["HTTP 507", /server error/i],
] as const)
	test("failure: " + raw, () => {
		const next = step(initial(), {
			type: "result",
			subtype: "success",
			is_error: true,
			result: raw,
		} as SDKMessage);
		assert.equal(next.decision, "error");
		assert.match(next.state.message.errorMessage!, match);
		if (/key|billing/.test(raw))
			assert.doesNotMatch(next.state.message.errorMessage!, /overloaded|500/);
	});
