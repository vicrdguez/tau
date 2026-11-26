import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createModels,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	PI_AI_VERSION,
	type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { catalogProvider } from "../../src/command/catalog.js";

const generatedAt = Date.UTC(2026, 0, 1);
const modified = "Fri, 02 Jan 2026 00:00:00 GMT";
const etag = 'W/"shard-2"';
const [builtin] = openaiProvider().getModels();
assert.ok(builtin);
const future = { ...builtin, id: "future-model" };

async function registry(
	provider: Provider,
	store = new InMemoryModelsStore(),
	timestamp = generatedAt,
) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({
		type: "api_key",
		key: "secret-key",
	}));
	const models = createModels({ credentials, modelsStore: store });
	models.setProvider(catalogProvider(provider, timestamp));
	return models;
}

test("refresh merges a versioned provider shard by model type and revalidates the cached body", async (t) => {
	const store = new InMemoryModelsStore();
	const models = await registry(openaiProvider(), store);
	const requests: Request[] = [];
	const updated = { ...builtin, name: "New name" };
	t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
		requests.push(new Request(url, init));
		return requests.length > 1
			? new Response(null, { status: 304 })
			: Response.json(
					{
						models: [
							updated,
							future,
							{ ...future, type: "image", output: ["image"] },
							{ ...future, type: "classifier" },
							{ ...future, id: "unsupported", type: "audio" },
						],
					},
					{ headers: { "last-modified": modified, etag } },
				);
	});
	assert.equal(models.getModel("openai", future.id), undefined);
	assert.equal((await models.refresh({ force: true })).errors.size, 0);
	const [request] = requests;
	assert.ok(request);
	const url = new URL(request.url);
	assert.equal(
		url.origin + url.pathname,
		"https://pi.dev/api/models/providers/openai",
	);
	assert.equal(url.searchParams.get("types"), "chat,image,classifier");
	assert.ok(
		request.headers.get("user-agent")?.startsWith(`pi/${PI_AI_VERSION} `),
	);
	assert.equal(request.headers.get("if-none-match"), null);
	assert.equal(
		models.getModels("openai").filter((m) => m.id === updated.id).length,
		1,
	);
	assert.equal(models.getModel("openai", updated.id)?.name, "New name");
	assert.equal(models.getModel("openai", future.id)?.provider, "openai");
	for (const type of ["image", "classifier"] as const) {
		assert.equal(models.getModelOfType(type, "openai", future.id)?.type, type);
	}
	assert.equal(
		models.getAllModels().some((m) => m.id === "unsupported"),
		false,
	);

	const restarted = await registry(openaiProvider(), store);
	await restarted.refresh({ allowNetwork: false });
	assert.equal(restarted.getModel("openai", future.id)?.id, future.id);
	assert.equal(requests.length, 1);
	assert.equal((await restarted.refresh({ force: true })).errors.size, 0);
	assert.equal(requests[1]?.headers.get("if-none-match"), etag);
	assert.equal(restarted.getModel("openai", future.id)?.id, future.id);
	const upgraded = await registry(
		openaiProvider(),
		store,
		Date.parse(modified),
	);
	await upgraded.refresh({ allowNetwork: false });
	assert.equal(upgraded.getModel("openai", future.id), undefined);
});

test("an undated shard or one no newer than the built-ins cannot override them", async (t) => {
	const models = await registry(openaiProvider());
	let date: string;
	t.mock.method(globalThis, "fetch", async () =>
		Response.json([future], { headers: { "last-modified": date } }),
	);
	for (date of ["", new Date(generatedAt).toUTCString()]) {
		await models.refresh({ force: true });
		assert.equal(models.getModel("openai", future.id), undefined);
	}
});

test("an unavailable or invalid shard cannot displace the last good catalog", async (t) => {
	const store = new InMemoryModelsStore();
	const cached = { models: [future], lastModified: Date.parse(modified), etag };
	await store.write("openai", cached);
	const models = await registry(openaiProvider(), store);
	let response: Response;
	t.mock.method(globalThis, "fetch", async () => response);
	for (response of [
		new Response(null, { status: 404 }),
		new Response(null, { status: 503 }),
		Response.json(
			{ models: "invalid" },
			{ headers: { "last-modified": modified } },
		),
	]) {
		const result = await models.refresh({ force: true });
		if (response.status !== 404) assert.ok(result.errors.has("openai"));
		assert.equal(models.getModel("openai", future.id)?.id, future.id);
		assert.deepEqual(await store.read("openai"), cached);
	}
});

test("OpenRouter personalizes the merged catalog and restores it without sharing the key with pi.dev", async (t) => {
	const store = new InMemoryModelsStore();
	const models = await registry(openrouterProvider(), store);
	const hosts: string[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (url: URL | string, init: RequestInit) => {
			const request = new Request(url, init);
			const target = new URL(request.url);
			hosts.push(target.host);
			if (target.host === "pi.dev") {
				assert.doesNotMatch(
					JSON.stringify([request.url, [...request.headers]]),
					/secret-key/,
				);
				return Response.json(
					{ [future.id]: future },
					{ headers: { "last-modified": modified } },
				);
			}
			assert.equal(request.url, "https://openrouter.ai/api/v1/models/user");
			assert.equal(request.headers.get("authorization"), "Bearer secret-key");
			return Response.json({
				data: [{ id: future.id, context_length: 12345 }],
			});
		},
	);
	assert.equal((await models.refresh({ force: true })).errors.size, 0);
	const restarted = await registry(openrouterProvider(), store);
	await restarted.refresh({ allowNetwork: false });
	assert.deepEqual(
		restarted.getModels().map((m) => [m.id, m.provider, m.contextWindow]),
		[[future.id, "openrouter", 12345]],
	);
	assert.deepEqual(hosts, ["pi.dev", "openrouter.ai"]);
});

test("native dynamic providers keep their own authenticated gateway refresh", async (t) => {
	const radius = radiusProvider({
		id: "custom-radius",
		gateway: "https://radius.invalid",
	});
	t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
		assert.equal(String(url), "https://radius.invalid/v1/config");
		assert.equal(
			new Headers(init.headers).get("authorization"),
			"Bearer secret-key",
		);
		return Response.json({
			baseUrl: "https://radius.invalid",
			models: [future],
		});
	});
	const models = await registry(radius);
	assert.equal((await models.refresh({ force: true })).errors.size, 0);
	assert.equal(models.getModel(radius.id, future.id)?.api, "pi-messages");
});
