import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	openNodeSqliteStorage,
	type Storage,
} from "tau/durable";
import { obj } from "tau/schema";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	openStore,
} from "tau/testing";

export const model = { provider: "faux", modelId: "faux-1" };
const probe = defineTool({
	name: "probe",
	description: "Probe foreground child conversations",
	parameters: obj({}),
	replay: "safe",
	execute: async (_, api, c) => {
		const ids = await api.commit(async (tx) => {
			const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 3))
				.items;
			if (found.length) {
				assert.equal(found.length, 2);
				return found.map(({ id }) => id).sort();
			}
			const created = [];
			for (let i = 0; i < 2; i++) {
				const { id } = await tx.createConversation({
					ownership: { kind: "task", taskId: api.taskId },
				});
				await configure(tx, id, { extensions: [], tools: [], model });
				created.push(id);
			}
			return created.sort();
		}, c);
		const answers = await Promise.all(
			ids.map(async (id, i) => {
				const handle = await api.conversation(id, c);
				assert.ok(handle);
				const submission = await handle.submit(
					{
						type: "input",
						content: `question ${i}`,
						requestId: `probe:${api.taskId}:${i}`,
					},
					c,
				);
				const settled = await submission.wait(c);
				assert.equal(settled.status, "done");
				const entry = settled.answer;
				assert.ok(entry !== undefined);
				const answer = await api.commit((tx) => tx.entry(entry), c);
				return answer?.model
					?.flatMap((message) =>
						message.role === "assistant"
							? message.content.flatMap((part) =>
									part.type === "text" ? [part.text] : [],
								)
							: [],
					)
					.join("");
			}),
		);
		return {
			output: [{ type: "text", text: JSON.stringify(answers) }],
			control: { terminate: true },
		};
	},
});
export const extension = defineExtension({ name: "probe", tools: [probe] });
export async function probeStore(storage: Storage) {
	const registry = createRegistry();
	registry.install(extension);
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	return { ...(await openStore(storage, { registry, models }, ctx)), provider };
}

if (import.meta.main) {
	const [file] = process.argv.slice(2);
	assert.ok(file);
	const sqlite = await openNodeSqliteStorage(file);
	const storage = new Proxy(sqlite, {
		get(target, key) {
			if (key !== "commit") {
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args: Parameters<Storage["commit"]>) => {
				const result = await target.commit(...args);
				if (
					args[0]
						.slice(0, result.stored)
						.flat()
						.some(
							(w) =>
								w.type === "submission" &&
								w.value.requestId?.startsWith("probe:"),
						)
				) {
					writeSync(1, "committed:submission\n");
					process.kill(process.pid, "SIGKILL");
				}
				return result;
			};
		},
	});
	const { harness, provider } = await probeStore(storage);
	const root = await harness.root(ctx, {
		agent: { model, extensions: [extension] },
	});
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("probe", {})], {
			stopReason: "toolUse",
		}),
	]);
	harness.resume();
	await root.submit({ type: "input", content: "go" }, ctx);
	await root.waitForIdle(ctx);
	throw new Error("Tool did not reach the kill point");
}
