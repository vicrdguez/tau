import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { openNodeSqliteStorage } from "tau/durable";
import { fauxAssistantMessage, fauxText } from "tau/testing";
import { probeStore } from "./fixtures/dispatch-probe.ts";

test("dispatch: a killed toy tool joins its original children and reuses admitted submissions", {
	timeout: 20_000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "keel-dispatch-probe-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "store.sqlite");
	await assert.rejects(
		promisify(execFile)(
			process.execPath,
			[
				fileURLToPath(new URL("./fixtures/dispatch-probe.ts", import.meta.url)),
				file,
			],
			{ timeout: 10_000 },
		),
		{ signal: "SIGKILL", stdout: "committed:submission\n" },
	);
	const storage = await openNodeSqliteStorage(file);
	const { harness, provider } = await probeStore(storage);
	try {
		const tool = (
			await harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 10), ctx)
		).items[0];
		assert.ok(tool && tool.state.status !== "terminal");
		const children = () =>
			harness.commit(
				async (tx) =>
					(await tx.scanConversations({ ownerTaskId: tool.id }, 10)).items
						.map(({ id }) => id)
						.sort(),
				ctx,
			);
		const before = await children();
		assert.equal(before.length, 2);
		const submissions = async () =>
			(
				await Promise.all(
					before.map(
						async (id) =>
							(
								await storage.scanSubmissions(
									{ conversationId: id },
									10,
									undefined,
									ctx,
								)
							).items,
					),
				)
			).flat();
		const admitted = await submissions();
		assert.ok(admitted.length >= 1 && admitted.length <= before.length);
		assert.ok(
			admitted.every(
				({ status }) => status !== "done" && status !== "unanswered",
			),
		);
		provider.setResponses([
			fauxAssistantMessage([fauxText("first answer")]),
			fauxAssistantMessage([fauxText("second answer")]),
			fauxAssistantMessage("parent done"),
		]);
		harness.resume();
		await harness.waitForTask(tool.id, ctx);
		assert.deepEqual(await children(), before);
		const after = await submissions();
		assert.equal(after.length, 2);
		for (const { id } of admitted) assert.ok(after.some((s) => s.id === id));
		const root = await harness.conversation(tool.conversationId, ctx);
		assert.ok(root);
		await root.waitForIdle(ctx);
		const results = (await root.entries({}, 100, undefined, ctx)).items
			.flatMap(({ model }) => model ?? [])
			.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0]?.isError, false);
		const output = results[0]?.content[0];
		assert.ok(output?.type === "text");
		assert.deepEqual(
			(JSON.parse(output.text) as { answer: string }[])
				.map(({ answer }) => answer)
				.sort(),
			["first answer", "second answer"],
		);
	} finally {
		await harness.close(ctx);
	}
});
