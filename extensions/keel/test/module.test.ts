import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentChange, Extension, JsonObject, Tx } from "tau/durable";
import type { JsonSchema } from "tau/schema";
import * as Keel from "../src/index.ts";

type ExtensionModule = {
	readonly extension: Extension;
	readonly options?: {
		schema: JsonSchema;
		get(tx: Tx): Promise<JsonObject>;
		set(tx: Tx, value: JsonObject): Promise<void>;
	};
	readonly entry?: AgentChange | ((tx: Tx) => Promise<AgentChange>);
};

test("the module is an ExtensionModule with entry, so the host treats it as a workflow", () => {
	const module: ExtensionModule = Keel;
	assert.deepEqual(Object.keys(module).sort(), [
		"entry",
		"extension",
		"options",
	]);
	assert.equal(module.extension.name, "keel");
});

test("tool names carry no prefix; every publish is replay-safe, sequential, and for the model only", () => {
	const tools = Keel.extension.tools ?? [];
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["publish_mandate", "record_ruling", "publish_build", "publish_verdict"],
	);
	for (const tool of tools) {
		assert.equal(tool.replay, "safe", tool.name);
		assert.equal(tool.executionMode, "sequential", tool.name);
		assert.deepEqual(tool.callers, ["model"], tool.name);
	}
	assert.ok(
		(Keel.extension.tasks ?? []).every((task) =>
			task.definition.name.startsWith("keel."),
		),
	);
	assert.equal(Keel.extension.hooks?.length, 1);
});
