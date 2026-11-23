import assert from "node:assert/strict";
import { test } from "node:test";
import { effectKey } from "../src/kernel/ids.ts";
import {
	experimentDecisions,
	experimentEffect,
	experimentEvidence,
	experimentInput,
	finishExperiment,
	recordExperiment,
	startExperiment,
} from "../src/lanes/design/experiment.ts";

const protocol = {
	node: "L1",
	question: "Which cache size reads fewer blocks?",
	decisionRule: "Choose the size with fewer reads on all three runs.",
	controls: ["fixture dataset F", "same seed before every run"],
	axis: "cache capacity",
	variants: ["32 entries", "64 entries"],
};
const options = { design: "default/design", design_prototype: "opt/prototype" };
const key = effectKey("experiment/3");
const observation = ["Read counts: 41, 44, 41", "Read counts: 22, 23, 21"];
const choices = [
	"Emit cache events at info level.",
	"Name the cache localBlocks.",
];
const receipts = observation.map((line, i) => ({
	seat: "design_prototype",
	conversation: `child-${i}`,
	answer: JSON.stringify({
		observation: line,
		evidence: `Fixture F output: ${line}`,
		incidentalChoices: [choices[i]],
	}),
	error: null as string | null,
}));
const comparison = {
	winner: "64 entries",
	comparison: "64 entries reads fewer blocks on each of the three runs.",
};
function started(spec = protocol) {
	const result = startExperiment(3, spec, options);
	assert.ok("experiment" in result);
	return result.experiment;
}
const done = (results = receipts) => ({
	kind: "effect_done" as const,
	key,
	result: { results },
});
function observed(results = receipts) {
	const next = finishExperiment(started(), done(results));
	assert.ok(next);
	return next;
}

test("an experiment must pin a decision rule, controlled question and two to eight distinct variants", () => {
	for (const patch of [
		{ decisionRule: " " },
		{ node: "  " },
		{ question: "  " },
		{ axis: "  " },
		{ controls: [] },
		{ controls: ["shared seed", "  "] },
		...[
			["32 entries"],
			["32 entries", "32 entries"],
			["32 entries", " "],
			Array.from({ length: 9 }, (_, i) => `${i} entries`),
		].map((variants) => ({ variants })),
	])
		assert.ok(
			"reject" in startExperiment(3, { ...protocol, ...patch }, options),
			JSON.stringify(patch),
		);
	assert.equal(
		started({
			...protocol,
			variants: Array.from({ length: 8 }, (_, i) => `${i} entries`),
		}).jobs.length,
		8,
	);
});

test("each prototype gets the same protocol, its own variant, and the pinned model", () => {
	const effect = experimentEffect(started());
	assert.equal(effect?.key, key);
	assert.equal(effect.spec.kind, "arena_dispatch");
	const jobs = effect.spec.jobs as {
		seat: string;
		model: string;
		question: string;
	}[];
	assert.equal(jobs.length, 2);
	for (const [i, job] of jobs.entries()) {
		assert.equal(job.seat, "design_prototype");
		assert.equal(job.model, "opt/prototype");
		for (const fact of [
			protocol.question,
			protocol.decisionRule,
			...protocol.controls,
			protocol.axis,
			protocol.variants[i]!,
		])
			assert.ok(job.question.includes(fact), fact);
		assert.ok(!job.question.includes(protocol.variants[1 - i]!));
	}
});

test("only the current dispatch and one comparison can settle an experiment", () => {
	const pending = started();
	assert.ok("reject" in recordExperiment(pending, comparison));
	assert.equal(
		finishExperiment(pending, { ...done(), key: effectKey("experiment/2") }),
		null,
	);
	const next = observed();
	assert.equal(experimentEffect(next), null);
	assert.equal(finishExperiment(next, done()), null);
	for (const invalid of [
		{ ...comparison, winner: "no cache" },
		{ ...comparison, comparison: " " },
	])
		assert.ok("reject" in recordExperiment(next, invalid));
	const decorated = observed(
		receipts.map((r, i) => ({
			...r,
			answer: i === 0 ? `\`\`\`json\n${r.answer}\n\`\`\`` : `Log: ${r.answer}`,
		})),
	);
	const result = recordExperiment(decorated, comparison);
	assert.ok("experiment" in result);
	assert.ok("reject" in recordExperiment(result.experiment, comparison));
	assert.deepEqual(experimentDecisions(result.experiment), [
		"Name the cache localBlocks.",
	]);
	const text = experimentEvidence(result.experiment);
	for (const part of [
		"L1",
		protocol.decisionRule,
		"32 entries",
		"64 entries",
		"child-0",
		"child-1",
		...observation.map((line) => `Evidence: Fixture F output: ${line}`),
		comparison.comparison,
	])
		assert.ok(text.includes(part), part);
});

test("failed children and unusable reports are retained but cannot establish a winner", () => {
	for (const [answer, error, evidence] of [
		["", "Prototype timed out.", /Prototype timed out/],
		[
			'{"observation":"Fewer reads","evidence":"Logs"}',
			null,
			/Raw answer:[\s\S]*Fewer reads/,
		],
	] as const) {
		const next = observed(receipts.with(0, { ...receipts[0]!, answer, error }));
		assert.ok("reject" in recordExperiment(next, comparison));
		assert.match(experimentInput(next), evidence);
		assert.match(experimentInput(next), /22, 23, 21/);
		const result = recordExperiment(next, {
			comparison: "One variant had no usable report.",
		});
		assert.ok("experiment" in result);
		assert.match(experimentEvidence(result.experiment), /inconclusive/i);
		assert.deepEqual(experimentDecisions(result.experiment), []);
	}
});

test("an effect failure or incomplete batch cannot win and does not redispatch", () => {
	for (const [fact, message] of [
		[
			{
				kind: "effect_failed",
				key,
				error: "Cannot prepare a scratch directory.",
			},
			/Cannot prepare/,
		],
		[done(receipts.slice(0, 1)), /does not match/],
	] as const) {
		const next = finishExperiment(started(), fact);
		assert.ok(next);
		assert.equal(experimentEffect(next), null);
		assert.ok("reject" in recordExperiment(next, comparison));
		assert.match(experimentInput(next), message);
	}
});
