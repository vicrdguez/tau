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
import { type FauxResponseStep, fauxAssistantMessage } from "tau/testing";
import type { DispatchResult } from "../src/dispatch/index.ts";
import { probeStore, started } from "./fixtures/dispatch-probe.ts";
import { dispatchPlanV1 } from "./state/dispatch.plan.ts";

const child = fileURLToPath(
	new URL("./fixtures/dispatch-probe.ts", import.meta.url),
);
const answers = ["first answer", "second answer"];
for (const expired of [false, true])
	test(expired
		? "after a crash past the deadline, unstarted seats time out without a new model call"
		: "dispatch: a killed toy tool joins its original children and reuses admitted submissions", {
		timeout: 20_000,
	}, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "keel-dispatch-probe-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const file = join(dir, "store.sqlite");
		await assert.rejects(
			promisify(execFile)(process.execPath, [child, file], { timeout: 10_000 }),
			{ signal: "SIGKILL", stdout: "committed:submission\n" },
		);
		const storage = await openNodeSqliteStorage(file);
		const { harness, provider } = await probeStore(
			storage,
			() => started + (expired ? 2 * 60 * 60_000 : 0),
		);
		t.after(() => harness.close(ctx));
		const commit = harness.commit.bind(harness);
		const [tool] = (
			await commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 10), ctx)
		).items;
		assert.ok(tool && tool.state.status !== "terminal");
		const children = () =>
			commit(
				async (tx) =>
					(await tx.scanConversations({ ownerTaskId: tool.id }, 10)).items
						.map(({ id }) => id)
						.sort((a, b) => a - b),
				ctx,
			);
		const before = await children();
		assert.equal(before.length, 2);
		const plan = await storage.findDocument(
			{ kind: "dispatch.plan", scope: { kind: "task", taskId: tool.id } },
			"current",
			ctx,
		);
		assert.ok(plan);
		const saved = await storage.document(plan.id, "current", ctx);
		assert.equal(saved?.version, 1);
		assert.deepEqual(
			saved?.value,
			dispatchPlanV1(started + 20 * 60_000, before),
		);
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
		assert.equal(
			admitted.length,
			1,
			"the kill persisted only the first admission",
		);
		assert.ok(
			admitted.every(
				({ status }) => status !== "done" && status !== "unanswered",
			),
		);

		const called: number[] = [];
		const response: FauxResponseStep = ({ messages }, options) => {
			const prompt = JSON.stringify(
				messages.filter((m) => m.role === "user").at(-1),
			);
			const index = ["first question", "second question"].findIndex(
				(question) => prompt.includes(question),
			);
			if (index < 0) return fauxAssistantMessage("parent done");
			called.push(index);
			if (!expired) return fauxAssistantMessage(answers[index]!);
			const signal = options?.signal;
			assert.ok(signal);
			signal.throwIfAborted();
			return new Promise<never>((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				}),
			);
		};
		provider.setResponses(Array.from({ length: 3 }, () => response));
		harness.resume();
		await harness.waitForTask(tool.id, ctx);
		assert.deepEqual(await children(), before);
		const after = await submissions();
		assert.equal(after.length, expired ? 1 : 2);
		assert.ok(after.some((s) => s.id === admitted[0]!.id));
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
		const joined = JSON.parse(output.text) as DispatchResult[];
		assert.deepEqual(
			joined.map(({ conversation, answer, error }) => [
				conversation,
				answer,
				error,
			]),
			before.map((id, i) =>
				expired
					? [id, null, "Dispatch child timed out."]
					: [id, answers[i], null],
			),
		);
		if (expired)
			assert.ok(
				called.every((i) => before[i] === admitted[0]!.conversationId),
				"no request for the unadmitted child",
			);
	});
