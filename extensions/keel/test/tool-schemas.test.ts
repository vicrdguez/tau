import assert from "node:assert/strict";
import { test } from "node:test";
import { extension } from "../src/index.ts";

const synthesis =
	"draft.intent draft.done draft.seams.label draft.seams.callersNow draft.seams.callersLater draft.seams.usage draft.seams.signature draft.seams.owner draft.seams.dependencies draft.nodes.label draft.nodes.rule draft.nodes.probe draft.never draft.tradeoffs draft.alternatives draft.settlements.label draft.settlements.ruling draft.checks.id draft.checks.argv draft.checks.timeoutMs draft.riders.label draft.riders.text draft.riders.origin draft.riders.disposition draft.references.label draft.references.source grafts.seat grafts.label grafts.text outcomes.source outcomes.n outcomes.kind outcomes.label outcomes.reason";

// These are model-authored facts, never repository identities. Check every
// registered tool (including nested Mandate and item records), not TS cast syntax.
const inputs: Record<string, string> = {
	dispatch: "jobs.seat jobs.question",
	start_experiment: "node question decisionRule controls axis variants",
	record_experiment: "comparison winner",
	frame_arena: "question rubric",
	answer_challenger:
		"dispositions.n dispositions.status dispositions.reason " +
		synthesis
			.split(" ")
			.map((field) => `revision.${field}`)
			.join(" "),
	ground:
		"route reference readings audit.exists audit.gaps.label audit.gaps.text audit.contradictions.label audit.contradictions.text mandate.intent mandate.nodes.label mandate.nodes.rule mandate.nodes.probe mandate.checks.id mandate.checks.argv mandate.checks.timeoutMs",
	publish_mandate: `${synthesis} replies.n replies.status replies.reason base`,
	publish_revision:
		"changes.intent changes.nodes.label changes.nodes.rule changes.nodes.probe changes.remove changes.seams.label changes.seams.callersNow changes.seams.callersLater changes.seams.usage changes.seams.signature changes.seams.owner changes.seams.dependencies changes.checks.id changes.checks.argv changes.checks.timeoutMs changes.sections.label changes.sections.body replies.n replies.status replies.reason answers.cause answers.nodes answers.reason",
	file_finding:
		"text report nodes blocking source edgeCase.failure edgeCase.likelihood edgeCase.cost",
	report_investigation:
		"finding classification nodes evidence size recommendation cause sameAs reference",
	principle: "name",
	publish_plan:
		"items.id items.kind items.goal items.deps replies.n replies.status replies.reason",
	brief_item: "item goal evidence fences nodes",
	handoff_build: "summary risk",
	record_ruling: "what why cost rank follows principles pattern",
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
		schema.type === "string" ||
			schema.type === "integer" ||
			schema.type === "boolean" ||
			schema.enum,
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
