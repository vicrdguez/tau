import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { CodingTools, createRegistry, MemoryStorage } from "tau/durable";
import { createModels, openStore } from "tau/testing";
import { entry, extension, options } from "../src/index.ts";

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
	const tools = agent.tools.map((tool) => tool.name);
	for (const allowed of ["ground", "dispatch", "bash", "read"])
		assert.ok(tools.includes(allowed), allowed);
	for (const denied of ["publish_build", "publish_verdict", "edit", "write"])
		assert.ok(!tools.includes(denied), denied);
	assert.deepEqual(
		agent.extensions.map((ext) => ext.name).sort(),
		[CodingTools.name, "keel"].sort(),
	);
});
