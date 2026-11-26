import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import {
	defineExtension,
	defineTask,
	defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import type { Provider } from "tau";
import { fileModelsStore } from "../../src/command/models-store.js";
import type { ExtensionScan } from "../../src/host/index.js";
import { flow, notes, search, WEEK } from "./extensions.js";
import { faux, newHome, type Running, start } from "./helpers.js";

function provider(id: string, model: string, ...replies: string[]): Provider {
	const handle = fauxProvider({ provider: id, models: [{ id: model }] });
	handle.setResponses(replies.map((reply) => fauxAssistantMessage(reply)));
	return handle.provider;
}

async function listed(s: Running, call: "extensions" | "models") {
	const reply = await s.call(call, {});
	assert.equal(reply.status, 200);
	return reply.body.result.items
		.map((item: { name: string; model?: string }) => item.model ?? item.name)
		.sort();
}

async function bind(s: Running, extensions: string[] = []) {
	const reply = await s.call("bind", {
		project: "p",
		workdir: "/p",
		extensions,
	});
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
}

async function create(s: Running, model: string): Promise<number> {
	const reply = await s.call("create", { project: "p", model });
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
	return reply.body.result.conversation;
}

async function ask(
	s: Running,
	conversation: number,
	requestId: string,
	answer: string,
) {
	const params = { project: "p", conversation };
	const watch = s.watch("open", params);
	try {
		const reply = await s.call("input", {
			...params,
			text: "Hello.",
			requestId,
			whenBusy: "followUp",
		});
		assert.equal(reply.status, 200, JSON.stringify(reply.body));
		await watch.until(
			(w) =>
				w.closed || JSON.stringify(w.value?.entries ?? []).includes(answer),
			answer,
		);
		assert.equal(watch.status, 200);
		assert.ok(JSON.stringify(watch.value.entries).includes(answer));
	} finally {
		watch.close();
	}
}

async function reload(s: Running) {
	const reply = await s.server.reload();
	assert.ok("result" in reply, JSON.stringify(reply));
	return reply.result;
}

test("a provider supplies models to projects that did not select its extension", async (t) => {
	const s = await start({
		source: () => ({
			modules: {
				notes: {
					...notes,
					providers: [provider("custom", "chat", "From the extension.")],
				},
			},
			failures: [],
		}),
	});
	t.after(() => s.close());
	assert.deepEqual(await listed(s, "models"), [
		"custom/chat",
		"faux/a",
		"faux/b",
		"faux/c",
	]);
	await bind(s);
	await ask(s, await create(s, "custom/chat"), "first", "From the extension.");
});

test("an extension's saved models restore offline on restart and reload", async (t) => {
	const home = await newHome();
	const cache = join(home, "models.json");
	const handle = fauxProvider({
		provider: "custom",
		models: [{ id: "saved" }],
	});
	const models = () => ({
		faux: handle,
		models: createModels({ modelsStore: fileModelsStore(cache) }),
	});
	let requests = 0;
	const source = () => ({
		modules: {
			notes: {
				...notes,
				providers: [
					createProvider({
						id: "custom",
						auth: handle.provider.auth,
						api: handle.provider,
						models: [],
						fetchModels: async () => {
							requests++;
							return [handle.getModel()];
						},
					}),
				],
			},
		},
		failures: [],
	});
	const s = await start({ home, models: models(), source });
	t.after(() => s.close());
	assert.deepEqual(await listed(s, "models"), []);
	const refreshed = await s.call("models", { refresh: true });
	assert.equal(refreshed.status, 200);
	assert.deepEqual(await listed(s, "models"), ["custom/saved"]);
	assert.equal(requests, 1);

	const restarted = await s.restart({ models: models() });
	t.after(() => restarted.close());
	assert.deepEqual(await listed(restarted, "models"), ["custom/saved"]);
	assert.equal((await reload(restarted)).status, "applied");
	assert.deepEqual(await listed(restarted, "models"), ["custom/saved"]);
	assert.equal(requests, 1);
});

test("a model-format option accepts an extension's model", async (t) => {
	const s = await start({
		source: () => ({
			modules: {
				flow,
				notes: { ...notes, providers: [provider("custom", "chat")] },
			},
			failures: [],
		}),
	});
	t.after(() => s.close());
	await bind(s, ["flow"]);
	const reply = await s.call("setOptions", {
		project: "p",
		extension: "flow",
		patch: { designer: "custom/chat" },
	});
	assert.deepEqual(reply.body, {
		result: { value: { designer: "custom/chat" } },
	});
});

test("a built-in provider id rejects the extension without replacing the built-in", async (t) => {
	const stderr = t.mock.method(process.stderr, "write", () => true);
	const s = await start({
		source: () => ({
			modules: {
				notes: {
					...notes,
					providers: [provider("faux", "a", "Wrong provider.")],
				},
				search,
			},
			failures: [],
		}),
	});
	t.after(() => s.close());
	assert.deepEqual(await listed(s, "extensions"), ["search"]);
	assert.match(
		stderr.mock.calls.map((call) => call.arguments[0]).join(""),
		/extension notes \[providers\]/,
	);
	s.faux.setResponses([fauxAssistantMessage("From the built-in.")]);
	await bind(s);
	await ask(s, await create(s, "faux/a"), "first", "From the built-in.");
});

test("the first extension by name owns a shared provider id", async (t) => {
	const stderr = t.mock.method(process.stderr, "write", () => true);
	const s = await start({
		source: () => ({
			modules: {
				search: {
					...search,
					providers: [
						provider("discarded", "chat"),
						provider("shared", "second"),
					],
				},
				notes: { ...notes, providers: [provider("shared", "first")] },
			},
			failures: [],
		}),
	});
	t.after(() => s.close());
	assert.deepEqual(await listed(s, "extensions"), ["notes"]);
	assert.match(
		stderr.mock.calls.map((call) => call.arguments[0]).join(""),
		/extension search \[providers\]/,
	);
	assert.deepEqual(await listed(s, "models"), [
		"faux/a",
		"faux/b",
		"faux/c",
		"shared/first",
	]);
});

const valid = provider("custom", "chat");
const { streamSimple: _streamSimple, ...noStreamSimple } = valid;
for (const [name, providers] of [
	["a non-array export", valid],
	["a non-object provider", [null]],
	["no auth object", [{ ...valid, auth: null }]],
	["no getModels", [{ ...valid, getModels: null }]],
	["no stream", [{ ...valid, stream: null }]],
	["no streamSimple", [noStreamSimple]],
	["an empty id", [{ ...valid, id: "" }]],
	["an id containing a slash", [{ ...valid, id: "invalid/id" }]],
	["duplicate ids", [valid, valid]],
] as const) {
	test(`reload rejects ${name} at the providers stage`, async (t) => {
		let scan: ExtensionScan = { modules: {}, failures: [] };
		const s = await start({ source: () => scan });
		t.after(() => s.close());
		scan = { modules: { notes: { ...notes, providers } }, failures: [] };
		const report = await reload(s);
		assert.equal(report.status, "refused");
		assert.deepEqual(
			report.failures.map(({ name, stage }) => [name, stage]),
			[["notes", "providers"]],
		);
	});
}

test("reload replaces the provider for an existing conversation, then removes it", async (t) => {
	let scan: ExtensionScan = {
		modules: {
			notes: {
				...notes,
				providers: [provider("custom", "chat", "Original reply.")],
			},
		},
		failures: [],
	};
	const s = await start({ source: () => scan });
	t.after(() => s.close());
	await bind(s);
	const conversation = await create(s, "custom/chat");
	await ask(s, conversation, "first", "Original reply.");

	scan = {
		modules: {
			notes: {
				...notes,
				providers: [provider("custom", "chat", "Replacement reply.")],
			},
		},
		failures: [],
	};
	assert.equal((await reload(s)).status, "applied");
	await ask(s, conversation, "second", "Replacement reply.");

	scan = { modules: { notes }, failures: [] };
	assert.equal((await reload(s)).status, "applied");
	assert.deepEqual(await listed(s, "models"), ["faux/a", "faux/b", "faux/c"]);
});

test("a compatibility refusal keeps the previous provider serving", async (t) => {
	let scan: ExtensionScan = {
		modules: {
			flow,
			notes: {
				...notes,
				providers: [provider("custom", "chat", "Still the original.")],
			},
		},
		failures: [],
	};
	const s = await start({ source: () => scan });
	t.after(() => s.close());
	await bind(s);
	const conversation = await create(s, "custom/chat");

	scan = {
		modules: {
			flow: { extension: defineExtension({ name: "flow" }) },
			notes: { ...notes, providers: [provider("custom", "new-chat")] },
		},
		failures: [],
	};
	const report = await reload(s);
	assert.equal(report.status, "refused");
	assert.ok(
		report.failures.some(
			(failure) => failure.name === "flow" && failure.stage === "compatibility",
		),
	);
	assert.deepEqual(await listed(s, "models"), [
		"custom/chat",
		"faux/a",
		"faux/b",
		"faux/c",
	]);
	await ask(s, conversation, "first", "Still the original.");
});

test("reload refuses a new extension that claims a kept extension's provider", async (t) => {
	let scan: ExtensionScan = {
		modules: { notes: { ...notes, providers: [provider("shared", "kept")] } },
		failures: [],
	};
	const s = await start({ source: () => scan });
	t.after(() => s.close());

	scan = {
		modules: { search: { ...search, providers: [provider("shared", "new")] } },
		failures: [],
	};
	const report = await reload(s);
	assert.equal(report.status, "refused");
	assert.deepEqual(
		report.failures.map(({ name, stage }) => [name, stage]),
		[["search", "providers"]],
	);
	assert.deepEqual(await listed(s, "extensions"), ["notes"]);
	assert.deepEqual(await listed(s, "models"), [
		"faux/a",
		"faux/b",
		"faux/c",
		"shared/kept",
	]);
});

test("a due task can stream from an extension provider on restart", async (t) => {
	let clock = Date.UTC(2026, 10, 14);
	const due = defineTask<{ deadline: number }, { phase: "reply" }, null>({
		name: "resume.due",
		version: 1,
		initial: () => ({ phase: "reply" }),
		phases: {
			reply: async (task, runtime, c) => {
				if (runtime.now() < task.input.deadline) {
					await runtime.sleepUntil(task.input.deadline, { phase: "reply" }, c);
					return;
				}
				const model = runtime.models.getModel("custom", "chat");
				if (model === undefined) throw new Error("custom/chat is unavailable");
				const message = await runtime.models.completeSimple(model, {
					messages: [],
				});
				await runtime.commit(async (tx) => {
					await tx.appendEntry(task.conversationId, {
						kind: "resume.replied",
						data: {
							text:
								message.content.find((block) => block.type === "text")?.text ??
								"",
						},
					});
					return {
						status: "terminal",
						outcome: { status: "completed", result: null },
					};
				}, c);
			},
		},
		abort: (_task, runtime, c) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				c,
			),
	});
	const extension = defineExtension({
		name: "resume",
		tasks: [due],
		tools: [
			defineTool({
				name: "schedule",
				description: "Schedule a model request.",
				parameters: obj({}),
				execute: async (_args, api, c) => {
					await api.commit(
						(tx) =>
							tx.createTask(
								due,
								{ deadline: api.now() + WEEK },
								{
									ownership: { kind: "conversation" },
									conversationId: api.conversationId,
									background: true,
								},
							),
						c,
					);
					return { output: [] };
				},
			}),
		],
	});
	const s = await start({
		now: () => clock,
		source: () => ({ modules: { resume: { extension } }, failures: [] }),
	});
	t.after(() => s.close());
	await bind(s, ["resume"]);
	const conversation = await create(s, "faux/a");
	s.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("schedule", {})], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Scheduled the model request."),
	]);
	await ask(s, conversation, "schedule", "Scheduled the model request.");
	await s.close();
	clock += WEEK + 1;

	const models = faux();
	const restarted = await s.restart({
		models,
		source: () => ({
			modules: {
				resume: {
					extension,
					providers: [
						provider("custom", "chat", "Reply from the resumed task."),
					],
				},
			},
			failures: [],
		}),
		storage: (file) => {
			assert.ok(
				models.models.getModel("custom", "chat"),
				"model available when a persisted project opens",
			);
			return openNodeSqliteStorage(file);
		},
	});
	t.after(() => restarted.close());
	const watch = restarted.watch("open", { project: "p", conversation });
	try {
		await watch.until(
			(w) =>
				w.closed ||
				JSON.stringify(w.value?.entries ?? []).includes(
					"Reply from the resumed task.",
				),
		);
		assert.equal(watch.status, 200);
		assert.ok(
			JSON.stringify(watch.value.entries).includes(
				"Reply from the resumed task.",
			),
		);
	} finally {
		watch.close();
	}
});
