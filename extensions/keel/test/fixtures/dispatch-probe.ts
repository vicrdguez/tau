import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	createRegistry,
	defineExtension,
	openNodeSqliteStorage,
	type Storage,
} from "tau/durable";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	openStore,
} from "tau/testing";
import { dispatchTool } from "../../src/dispatch/index.ts";

export const model = { provider: "faux", modelId: "faux-1" };
export const started = 1_800_000_000_000;
const dispatch = dispatchTool({
	resolve: (_, _caller, { seat }) =>
		seat === "reader"
			? {
					extensions: [],
					tools: [],
					model,
					instructions: "Reply with a short answer.",
				}
			: undefined,
});
const extension = defineExtension({ name: "probe", tools: [dispatch] });
export async function probeStore(storage: Storage, now = Date.now) {
	const registry = createRegistry();
	registry.install(extension);
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	return {
		...(await openStore(storage, { registry, models, now }, ctx)),
		provider,
	};
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
			return async (
				...[batches, receive, context]: Parameters<Storage["commit"]>
			) => {
				const index = batches.findIndex((batch) =>
					batch.some(
						(w) =>
							w.type === "submission" &&
							w.value.requestId?.startsWith("dispatch:"),
					),
				);
				// Storage may coalesce transactions. Write only the prefix through the first admission.
				const result = await target.commit(
					index < 0 ? batches : batches.slice(0, index + 1),
					receive,
					context,
				);
				if (index >= 0 && result.stored > index) {
					writeSync(1, "committed:submission\n");
					process.kill(process.pid, "SIGKILL");
				}
				return result;
			};
		},
	});
	const { harness, provider } = await probeStore(storage, () => started);
	const root = await harness.root(ctx, {
		agent: { model, extensions: [extension] },
	});
	provider.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("dispatch", {
					jobs: [
						{ seat: "reader", question: "first question" },
						{ seat: "reader", question: "second question" },
					],
				}),
			],
			{
				stopReason: "toolUse",
			},
		),
	]);
	harness.resume();
	await root.submit({ type: "input", content: "go" }, ctx);
	await root.waitForIdle(ctx);
	throw new Error("Tool did not reach the kill point");
}
