import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { CodingTools, createRegistry, MemoryStorage } from "tau/durable";
import { createModels, openStore } from "tau/testing";
import { entry, extension, options } from "../src/index.ts";

// Check the module Tau loads, not the toy kernel. A missing task prevents
// recovery; a toy or future lane tool advertises work Keel cannot perform.
test("Keel registers its four recovery tasks and the real lane tools", () => {
	assert.equal(extension.name, "keel");
	assert.deepEqual(
		extension.tasks?.map((task) => task.definition.name).sort(),
		["keel.answer", "keel.deliver", "keel.effect", "keel.stop"],
	);
	const tools = extension.tools?.map((tool) => tool.name) ?? [];
	for (const name of [
		"ground",
		"publish_mandate",
		"publish_revision",
		"principle",
		"request_cancel",
		"publish_plan",
		"brief_item",
		"record_ruling",
		"file_finding",
		"report_investigation",
		"publish_build",
		"publish_verdict",
		"handoff_build",
	])
		assert.ok(tools.includes(name), name);
	assert.equal(tools.length, new Set(tools).size);
});

test("the public workflow entry starts a designer with its own model and coding tools", async (t) => {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(extension);
	const { harness } = await openStore(
		new MemoryStorage(),
		{ registry, models: createModels() },
		ctx,
	);
	t.after(() => harness.close(ctx));
	await harness.commit(
		(tx) =>
			options.set(tx, {
				design: "lane/design",
				build: "lane/build",
				verify: "lane/verify",
				queue: "lane/queue",
				designer: "designer/chosen",
			}),
		ctx,
	);
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: await harness.commit((tx) => entry(tx), ctx),
		},
		ctx,
	);
	const agent = await conversation.agent(ctx);
	assert.deepEqual(agent.model, { provider: "designer", modelId: "chosen" });
	assert.match(agent.instructions ?? "", /`file_finding` with `source: \"owner\"`/);
	assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), [
		"bash",
		"file_finding",
		"ground",
		"principle",
		"publish_mandate",
		"publish_revision",
		"read",
		"request_cancel",
	]);
	assert.deepEqual(
		agent.extensions.map((ext) => ext.name).sort(),
		[CodingTools.name, "keel"].sort(),
	);
});
