import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "@earendil-works/pi-ai/models";
import { faux, type Reply, start } from "./helpers.js";

function dynamicModels(upstream: (force?: boolean) => Promise<string[]>) {
	const fixture = faux();
	const { provider } = fixture.faux;
	const template = fixture.faux.getModel();
	fixture.models.setProvider(
		createProvider({
			id: provider.id,
			auth: provider.auth,
			api: provider,
			models: [],
			fetchModels: async ({ force }) =>
				(await upstream(force)).map((id) => ({ ...template, id, name: id })),
		}),
	);
	return fixture;
}

const secret = "sk-provider-secret-0123456789";

function assertRefreshRefused(reply: Reply) {
	assert.equal(reply.status, 503);
	assert.deepEqual(Object.keys(reply.body), ["refused"]);
	assert.equal(reply.body.refused?.code, "model_refresh_failed");
	assert.ok(reply.body.refused?.message);
	assert.ok(!JSON.stringify(reply.body).includes(secret));
}

test("only an explicit model refresh fetches upstream and makes an unknown model selectable", async (t) => {
	let requests = 0;
	const id = "future/chat-2028-09";
	const model = `faux/${id}`;
	const items = [{ model, name: id }];
	const s = await start({
		models: dynamicModels(async (force) => {
			requests++;
			return force ? [id] : [];
		}),
	});
	t.after(() => s.close());

	assert.equal(
		(await s.call("bind", { project: "p", workdir: "/p", extensions: [] }))
			.status,
		200,
	);
	const select = () => s.call("create", { project: "p", model });
	assert.equal((await select()).body.refused?.code, "unknown_model");
	assert.deepEqual((await s.call("models", {})).body, {
		result: { items: [] },
	});
	assert.deepEqual((await s.call("models", { refresh: false })).body, {
		result: { items: [] },
	});
	const invalid = await s.call("models", { refresh: "true" });
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.refused?.code, "bad_request");
	assert.equal(requests, 0);

	assert.deepEqual((await s.call("models", { refresh: true })).body, {
		result: { items },
	});
	assert.deepEqual((await s.call("models", {})).body, { result: { items } });
	assert.equal(requests, 1);
	const created = await select();
	assert.equal(created.status, 200);
	const w = s.watch("open", {
		project: "p",
		conversation: created.body.result.conversation,
	});
	t.after(() => w.close());
	await w.until((watch) => watch.value !== undefined);
	assert.deepEqual(w.value.docs["pi.agent"].model, {
		provider: "faux",
		modelId: id,
	});
	w.close();
});

test("a failed provider refresh leaves the last catalog readable and can be retried", async (t) => {
	let fail = false;
	let id = "last-known";
	const s = await start({
		models: dynamicModels(async () => {
			if (fail) throw new Error(`Provider request failed with ${secret}`);
			return [id];
		}),
	});
	t.after(() => s.close());

	assert.deepEqual((await s.call("models", { refresh: true })).body, {
		result: { items: [{ model: "faux/last-known", name: "last-known" }] },
	});
	fail = true;
	assertRefreshRefused(await s.call("models", { refresh: true }));
	assert.deepEqual((await s.call("models", {})).body, {
		result: { items: [{ model: "faux/last-known", name: "last-known" }] },
	});
	fail = false;
	id = "replacement";
	assert.deepEqual((await s.call("models", { refresh: true })).body, {
		result: { items: [{ model: "faux/replacement", name: "replacement" }] },
	});
});

for (const [outcome, refresh] of [
	["aborted", async () => ({ aborted: true, errors: new Map() })],
	[
		"rejected",
		async () => {
			throw new Error(secret);
		},
	],
] as const) {
	test(`model refresh returns a safe refusal when ${outcome}`, async (t) => {
		const models = faux();
		t.mock.method(models.models, "refresh", refresh);
		const s = await start({ models });
		t.after(() => s.close());
		assertRefreshRefused(await s.call("models", { refresh: true }));
	});
}
