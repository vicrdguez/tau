import assert from "node:assert/strict";
import { test } from "node:test";
import { extension } from "../src/index.ts";

// These are model-authored facts, never repository identities. Check every
// registered tool (including nested Mandate and item records), not TS cast syntax.
const inputs: Record<string, string> = {
	ground:
		"route reference readings mandate.intent mandate.nodes.label mandate.nodes.rule mandate.nodes.probe mandate.checks.id mandate.checks.argv mandate.checks.timeoutMs mandate.protectedPaths",
	publish_plan: "items.id items.kind items.goal items.deps",
	brief_item: "item goal evidence fences nodes",
	handoff_build: "summary risk",
	record_ruling: "what why cost rank follows",
	publish_build: "summary addresses",
	publish_verdict:
		"outcome text blocks.thread blocks.ground blocks.evidence notes",
	publish_diagnosis: "premise test result",
};
type Schema = {
	type?: string;
	properties?: Record<string, Schema>;
	additionalProperties?: boolean;
	items?: Schema;
	enum?: unknown[];
};
function fields(schema: Schema, path: string): string[] {
	if (schema.type === "object") {
		assert.equal(schema.additionalProperties, false, `open object: ${path}`);
		return Object.entries(schema.properties ?? {}).flatMap(([name, child]) =>
			fields(child, path ? `${path}.${name}` : name),
		);
	}
	if (schema.type === "array") {
		assert.ok(schema.items, `open array: ${path}`);
		return fields(schema.items, path);
	}
	assert.ok(
		schema.type === "string" || schema.type === "integer" || schema.enum,
		`unreviewed parameter: ${path}`,
	);
	return [path];
}
test("no Keel tool accepts a commit hash: its entire argument surface is owner- or model-authored data", () => {
	assert.ok(extension.tools?.length);
	for (const tool of extension.tools)
		assert.deepEqual(
			fields(tool.parameters, "").sort(),
			(inputs[tool.name]?.split(" ") ?? []).sort(),
			tool.name,
		);
});
