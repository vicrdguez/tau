import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { openNodeSqliteStorage } from "tau/durable";
import { fauxAssistantMessage, fauxToolCall } from "tau/testing";
import { token } from "../src/kernel/ids.ts";
import { ReceiptState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { toy } from "./toy.ts";

const child = fileURLToPath(new URL("./fixtures/recovery.ts", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "tau-keel-recovery-"));
after(() => rm(dir, { recursive: true, force: true }));

async function reopen(t: TestContext, point: "publish" | "create") {
	const file = join(dir, `${point}.sqlite`);
	await assert.rejects(
		promisify(execFile)(process.execPath, [child, file, point], {
			timeout: 15_000,
		}),
		{ signal: "SIGKILL", stdout: `committed:${point}\n` },
	);

	const storage = await openNodeSqliteStorage(file);
	const x = await toy({ storage });
	t.after(() => x.harness.close(ctx));
	const agents = await x.agents();
	assert.equal(agents.length, 1, "one original worker");
	const worker = await x.harness.conversation(agents[0]!, ctx);
	assert.ok(worker);
	return { x, worker, storage };
}

test("SQLite SIGKILL after publish and before tool reply: replay returns the receipt without publishing again", async (t) => {
	const { x, worker } = await reopen(t, "publish");
	const replies = async () =>
		(await worker.entries({}, 100, undefined, ctx)).items
			.flatMap((e) => e.model ?? [])
			.filter((m) => m.role === "toolResult");
	assert.equal(
		(await x.state()).publications,
		1,
		"the publication was already durable",
	);
	assert.deepEqual(await replies(), [], "no tool result was durable");
	const tools = await x.tasks("pi.tool");
	assert.equal(tools.length, 1);
	const [call] = tools;
	assert.ok(
		call && call.state.status !== "terminal",
		"the publish call is unfinished",
	);
	const receipt = await x.harness.snapshot(
		stateDoc(ReceiptState),
		call.id,
		ctx,
	);
	assert.deepEqual(receipt, {
		reply: "published once",
		terminate: true,
		isError: false,
	});

	x.harness.resume();
	const replay = await x.harness.waitForTask(call.id, ctx);
	assert.equal(replay.state.outcome.status, "completed");
	await x.finish("keel.deliver");
	await worker.waitForIdle(ctx);
	assert.deepEqual(
		(await replies()).map((m) => ({
			tool: m.toolName,
			error: m.isError,
			output: m.content,
		})),
		[
			{
				tool: "publish",
				error: false,
				output: [{ type: "text", text: "published once" }],
			},
		],
	);
	assert.equal((await x.state()).publications, 1);
	assert.equal(x.provider.state.callCount, 0, "no replacement model call");
});

test("SQLite SIGKILL between worker creation and first submit: restart delivers exactly once to the original worker", async (t) => {
	const { x, worker, storage } = await reopen(t, "create");
	const submissions = async () =>
		(
			await storage.scanSubmissions(
				{ conversationId: worker.id },
				10,
				undefined,
				ctx,
			)
		).items;
	const conversationIds = async () =>
		x.harness.commit(
			async (tx) =>
				(await tx.scanConversations({}, 100)).items.map((c) => c.id),
			ctx,
		);
	const before = await conversationIds();
	assert.deepEqual(await submissions(), [], "no submission was admitted");
	assert.equal(
		(await x.tasks("keel.deliver")).length,
		1,
		"delivery intent survived",
	);

	x.provider.setResponses([
		fauxAssistantMessage([fauxToolCall("publish", {})], {
			stopReason: "toolUse",
		}),
	]);
	x.harness.resume();
	await x.finish("keel.deliver");
	await worker.waitForIdle(ctx);
	assert.deepEqual(
		await conversationIds(),
		before,
		"recovery created no new conversation",
	);
	assert.deepEqual(await x.agents(), [worker.id]);
	assert.deepEqual(
		(await submissions()).map((s) => s.requestId),
		[token("worker/0", 1)],
	);
	assert.equal(
		(await x.state()).publications,
		1,
		"the original worker completed its hand-off",
	);
});
