import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "tau/schema";
import { extension } from "../src/index.ts";

test("publication tools reject model-supplied commit identities at the schema boundary", () => {
	const sha = "f".repeat(40);
	const block = { thread: "t", ground: "failing_run", evidence: "Exit 1" };
	for (const [name, input, forged] of [
		["publish_build", { summary: "Fix", addresses: [] }, { sha }],
		[
			"publish_verdict",
			{ outcome: "fail", text: "Failed", blocks: [block], notes: [] },
			{ sha },
		],
		[
			"publish_verdict",
			{ outcome: "fail", text: "Failed", blocks: [block], notes: [] },
			{ blocks: [{ ...block, sha }] },
		],
	] as const) {
		const tool = extension.tools?.find((tool) => tool.name === name);
		assert.ok(tool, name);
		const schema = compile(tool.parameters);
		assert.equal(schema.validate(input).ok, true, name);
		assert.equal(schema.validate({ ...input, ...forged }).ok, false, name);
	}
});
