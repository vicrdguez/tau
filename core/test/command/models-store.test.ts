import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	open,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import { fileModelsStore } from "../../src/command/models-store.js";

const openrouter = {
	models: [
		{
			provider: "openrouter",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "example/future-chat",
			name: "Future Chat",
			reasoning: false,
			input: ["text"],
			contextWindow: 65536,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
	lastModified: 100,
	checkedAt: 200,
	etag: '"catalog-v1"',
} satisfies ModelsStoreEntry;
const anthropic = { models: [], checkedAt: 300 } satisfies ModelsStoreEntry;

async function cacheFile(t: TestContext) {
	const directory = await mkdtemp(path.join(tmpdir(), "tau-models-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return path.join(directory, "models.json");
}

test("reading or deleting from a missing cache does not create it", async (t) => {
	const file = await cacheFile(t);
	const store = fileModelsStore(file);
	assert.equal(await store.read("openrouter"), undefined);
	await assert.rejects(stat(file), { code: "ENOENT" });
	await store.delete("openrouter");
	await assert.rejects(stat(file), { code: "ENOENT" });
});

test("concurrent writes to the same file preserve both provider entries", async (t) => {
	const file = await cacheFile(t);
	const store = fileModelsStore(file);
	await Promise.all([
		store.write("openrouter", openrouter),
		store.write("anthropic", anthropic),
	]);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		openrouter,
		anthropic,
	});
});

test("reopens the previous format and replaces it atomically with private permissions", async (t) => {
	const file = await cacheFile(t);
	const original = `\uFEFF${JSON.stringify({ openrouter, anthropic })}`;
	await writeFile(file, original);
	await chmod(file, 0o644);
	const store = fileModelsStore(file);
	assert.deepEqual(await store.read("openrouter"), openrouter);

	const previous = await open(file, "r");
	const updated = { ...openrouter, checkedAt: 400, etag: '"catalog-v2"' };
	try {
		await store.write("openrouter", updated);
		assert.equal(await previous.readFile("utf8"), original);
	} finally {
		await previous.close();
	}
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	const reopened = fileModelsStore(file);
	assert.deepEqual(await reopened.read("openrouter"), updated);
	assert.deepEqual(await reopened.read("anthropic"), anthropic);
});

test("deleting a provider leaves an independent concurrent write intact", async (t) => {
	const file = await cacheFile(t);
	await writeFile(file, JSON.stringify({ openrouter }));
	const store = fileModelsStore(file);
	await Promise.all([
		store.write("anthropic", anthropic),
		store.delete("openrouter"),
	]);
	const reopened = fileModelsStore(file);
	assert.equal(await reopened.read("openrouter"), undefined);
	assert.deepEqual(await reopened.read("anthropic"), anthropic);
});

test("reports a malformed cache without overwriting it and permits retry after repair", async (t) => {
	const file = await cacheFile(t);
	const store = fileModelsStore(file);
	for (const malformed of ["{", "[]"]) {
		await writeFile(file, malformed);
		await assert.rejects(store.read("openrouter"));
		await assert.rejects(store.write("openrouter", openrouter));
		assert.equal(await readFile(file, "utf8"), malformed);
	}
	await writeFile(file, JSON.stringify({ anthropic }));
	await store.write("openrouter", openrouter);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		openrouter,
		anthropic,
	});
});

test("aborted operations leave the last catalog and a concurrent write intact", async (t) => {
	const file = await cacheFile(t);
	await writeFile(file, JSON.stringify({ openrouter }));
	const store = fileModelsStore(file);
	const controller = new AbortController();
	const options = { signal: controller.signal };
	const writing = store.write("anthropic", anthropic);
	const cancelled = store.write("openrouter", { models: [] }, options);
	controller.abort();
	await Promise.all([
		writing,
		assert.rejects(cancelled, { name: "AbortError" }),
		assert.rejects(store.read("openrouter", options), { name: "AbortError" }),
		assert.rejects(store.delete("openrouter", options), { name: "AbortError" }),
	]);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		openrouter,
		anthropic,
	});
});
