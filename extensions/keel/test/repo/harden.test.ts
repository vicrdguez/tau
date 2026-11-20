import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { layout, nodeExec } from "../../src/repo/index.ts";
import { fixture, git, is } from "./fixture.ts";

test("a proof deadline bounds inherited pipes even outside its group", async (t) => {
	const f = await fixture(t);
	const start = performance.now();
	const results = await Promise.all([false, true].map((wait) =>
		nodeExec([process.execPath, "-e", `
			require('child_process').spawn('sleep', ['3'], {
				detached: true, stdio: ['ignore', 'inherit', 'inherit']
			}).unref();
			${wait ? "setInterval(() => {}, 500)" : ""}
		`], f.root, { env: process.env, timeoutMs: 500 })
	));
	assert.deepEqual(results.map((r) => r.code), [124, 124]);
	assert.ok(performance.now() - start < 2500, "did not stop waiting for leaked pipes");
});
