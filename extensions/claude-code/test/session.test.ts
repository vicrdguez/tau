import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSession } from "cc-session-io";
import type { Message, SimpleStreamOptions } from "tau/ai";
import { failure, fakeClaudeCode, fixture } from "./fake-claude-code.ts";

const key = { sessionId: "conversation/../one" };
const user = (content: string): Message => ({
	role: "user",
	content,
	timestamp: 0,
});
const input = [user("first")];
const tool = {
	name: "add",
	description: "add",
	parameters: { type: "object" },
};
const text = () => ({ frames: fixture("text") });
type Fake = ReturnType<typeof fakeClaudeCode>;
function ask(
	f: Fake,
	messages: Message[],
	options: SimpleStreamOptions = key,
	model = f.model,
) {
	return f.models.completeSimple(model, { messages }, options);
}
function records(f: Fake) {
	return readdirSync(join(f.home, "claude/tau-work/sessions"))
		.filter((n) => n.endsWith(".json"))
		.map((n) => join(f.home, "claude/tau-work/sessions", n));
}

test("resume at Tau's grouped results below the final tool row, not the rejection branch", async (t) => {
	const f = fakeClaudeCode(t, { frames: fixture("parallel") }, text());
	const messages: Message[] = [
		{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
		...input,
	];
	const a = await ask(f, messages);
	assert.equal(a.stopReason, "toolUse", a.errorMessage);
	const path = f.requests[0]!.path;
	const before = readSession(path);
	const last = before.messages.findLast((row) => row.type === "assistant")!;
	const calls = a.content.filter((b) => b.type === "toolCall");
	assert.equal(calls.length, 2);
	const results = calls.map((c, i) => ({
		role: "toolResult" as const,
		toolName: c.name,
		toolCallId: c.id,
		content: [{ type: "text" as const, text: i ? "78" : "42" }],
		isError: false,
		timestamp: 1,
	}));
	const b = await ask(f, [...messages, a, ...results]);
	assert.equal(b.stopReason, "stop", b.errorMessage);
	const r = f.requests[1]!;
	assert.equal(r.options.resume, before.sessionId);
	const end = r.rows.at(-1)!;
	assert.equal(r.options.resumeSessionAt, end.uuid);
	assert.equal(end.parentUuid, last.uuid);
	assert.deepEqual(
		r.rows.slice(0, -1),
		before.records.slice(0, before.records.indexOf(last) + 1),
	);
	assert.deepEqual(r.history.at(-1), {
		role: "user",
		content: calls.map((c, i) => ({
			type: "tool_result",
			tool_use_id: c.id,
			content: i ? "78" : "42",
		})),
	});
	assert.match(String(r.prompt?.message.content), /ends with the tool result/);
});

test("a new provider resumes a text turn and discards crash leftovers", async (t) => {
	const f = fakeClaudeCode(t, text(), text());
	const a = await ask(f, input);
	const first = f.requests[0]!;
	const file = readSession(first.path);
	const leaf = file.messages.at(-1)!.uuid;
	file.addUserMessage("unpublished");
	file.save();
	const [record] = records(f);
	assert.ok(record);
	writeFileSync(record.replace(/\.json$/, ".lock"), '{"pid":1}');
	f.models.setProvider(f.newProvider());
	const b = await ask(f, [
		{ ...input[0]!, timestamp: 99 },
		a,
		user("steer"),
		user("next"),
	]);
	assert.equal(b.stopReason, "stop", b.errorMessage);
	const r = f.requests[1]!;
	assert.equal(r.path, first.path);
	assert.equal(r.options.resume, file.sessionId);
	assert.equal(r.rows.at(-1)?.parentUuid, leaf);
	assert.equal(r.rows.at(-1)?.uuid, r.options.resumeSessionAt);
	assert.equal(r.history.at(-1)?.content, "steer");
	assert.equal(r.prompt?.message.content, "next");
	assert.doesNotMatch(JSON.stringify(r.rows), /unpublished/);
});

for (const change of [
	"system",
	"tools",
	"model",
	"edit",
	"compaction",
	"broken record",
	"missing file",
	"damaged history",
])
	test("rebuild after " + change, async (t) => {
		const f = fakeClaudeCode(t, text(), text());
		const a = await ask(f, input);
		const old = f.requests[0]!.path;
		assert.ok(existsSync(old));
		const [record] = records(f);
		assert.ok(record);
		assert.equal(statSync(record).mode & 0o777, 0o600);
		if (change === "broken record") writeFileSync(record, "{");
		if (change === "missing file") readSession(old).clear();
		if (change === "damaged history") {
			const rows = readSession(old).records;
			writeFileSync(
				old,
				rows
					.map((row) => JSON.stringify(row).replace('"first"', '"other"'))
					.join("\n") + "\n",
			);
		}
		const messages: Message[] = [
			change === "edit" ? user("changed") : input[0]!,
			a,
		];
		if (change === "system" || change === "tools")
			messages.push({
				role: "system",
				content: change === "system" ? "updated" : "",
				toolsAdded: change === "tools" ? [tool] : [],
				timestamp: 1,
			});
		if (change === "compaction") messages.splice(0, 2, user("summary"));
		messages.push(user("next"));
		const b = await ask(f, messages, key, {
			...f.model,
			id: change === "model" ? "other" : f.model.id,
		});
		assert.equal(b.stopReason, "stop", b.errorMessage);
		assert.notEqual(f.requests[1]!.path, old);
		if (change !== "broken record") assert.ok(!existsSync(old));
		assert.equal(records(f).length, 1);
	});

test("cacheRetention none and unkeyed requests leave the kept session alone", async (t) => {
	const f = fakeClaudeCode(t, text(), text(), text(), text());
	const a = await ask(f, input);
	const next = [...input, a, user("next")];
	for (const opt of [{ ...key, cacheRetention: "none" as const }, {}]) {
		assert.equal((await ask(f, next, opt)).stopReason, "stop");
		const temp = f.requests.at(-1)!;
		assert.notEqual(temp.path, f.requests[0]!.path);
		assert.ok(!existsSync(temp.path));
	}
	assert.equal((await ask(f, next)).stopReason, "stop");
	assert.equal(f.requests[3]!.path, f.requests[0]!.path);
});

test("a failed continuation removes the record before retry", async (t) => {
	const f = fakeClaudeCode(
		t,
		text(),
		{ frames: failure("overloaded") },
		text(),
	);
	const a = await ask(f, input);
	const next = [...input, a, user("retry")];
	assert.equal((await ask(f, next)).stopReason, "error");
	assert.equal(f.requests[1]!.path, f.requests[0]!.path);
	assert.deepEqual(records(f), []);
	assert.equal((await ask(f, next)).stopReason, "stop");
	assert.notEqual(f.requests[2]!.path, f.requests[0]!.path);
});

test("a concurrent request gets a throwaway without invalidating the owner", async (t) => {
	const release = Promise.withResolvers<void>();
	const f = fakeClaudeCode(
		t,
		{ ...text(), wait: release.promise },
		text(),
		text(),
	);
	const first = ask(f, input);
	await f.started;
	try {
		assert.equal((await ask(f, input)).stopReason, "stop");
		assert.notEqual(f.requests[1]!.path, f.requests[0]!.path);
		assert.ok(!existsSync(f.requests[1]!.path));
	} finally {
		release.resolve();
	}
	const a = await first;
	assert.equal((await ask(f, [...input, a, user("next")])).stopReason, "stop");
	assert.equal(f.requests[2]!.path, f.requests[0]!.path);
});
