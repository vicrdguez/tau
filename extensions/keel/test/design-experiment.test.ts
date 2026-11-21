import assert from "node:assert/strict";
import { test } from "node:test";
import { effectKey } from "../src/kernel/ids.ts";
import {
	type Experiment,
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
const options = { design: "default/design" };

function start(modelOptions = options, spec = protocol) {
	const result = startExperiment(3, spec, modelOptions);
	assert.ok("experiment" in result, JSON.stringify(result));
	return result.experiment;
}

function answer(observation: string, incidentalChoices: string[]) {
	return JSON.stringify({
		observation,
		evidence: `Fixture F output: ${observation}`,
		incidentalChoices,
	});
}
const receipts: {
	seat: string;
	conversation: string;
	answer: string | null;
	error: string | null;
}[] = [
	{
		seat: "design_prototype",
		conversation: "child-a",
		answer: answer("Read counts: 41, 44, 41", [
			"Emit cache events at info level.",
		]),
		error: null,
	},
	{
		seat: "design_prototype",
		conversation: "child-b",
		answer: answer("Read counts: 22, 23, 21", ["Name the cache localBlocks."]),
		error: null,
	},
];

function settled(results = receipts): Experiment {
	const next = finishExperiment(start(), {
		kind: "effect_done",
		key: effectKey("experiment/3"),
		result: { results },
	});
	assert.ok(next);
	return next;
}

const comparison = {
	winner: "64 entries",
	comparison: "64 entries reads fewer blocks on each of the three runs.",
};

test("refuses to start an experiment without a written decision rule", () => {
	const result = startExperiment(
		3,
		{ ...protocol, decisionRule: " \t" },
		options,
	);
	assert.ok("reject" in result);
	assert.match(result.reject, /decision rule/i);
});

test("refuses a protocol without a node, observable question, controls or named axis", () => {
	for (const spec of [
		{ ...protocol, node: "  " },
		{ ...protocol, question: "  " },
		{ ...protocol, controls: [] },
		{ ...protocol, controls: ["shared seed", "  "] },
		{ ...protocol, axis: "  " },
	]) {
		assert.ok(
			"reject" in startExperiment(3, spec, options),
			JSON.stringify(spec),
		);
	}
});

test("requires two to eight distinct variants on the one named axis", () => {
	for (const variants of [
		["32 entries"],
		["32 entries", "32 entries"],
		["32 entries", " "],
		Array.from({ length: 9 }, (_, i) => `${i + 1} entries`),
	]) {
		assert.ok(
			"reject" in startExperiment(3, { ...protocol, variants }, options),
		);
	}
	const variants = Array.from({ length: 8 }, (_, i) => `${i + 1} entries`);
	assert.equal(
		start(options, { ...protocol, variants }).protocol.variants.length,
		8,
	);
});

test("declares one pinned prototype per variant with only that variant and all shared protocol facts", () => {
	const modelOptions = { ...options, design_prototype: "opt/prototype" };
	const experiment = start(modelOptions);
	modelOptions.design_prototype = "changed/model";
	const effect = experimentEffect(experiment);
	assert.ok(effect);
	assert.equal(effect.key, "experiment/3");
	assert.equal(effect.spec.kind, "arena_dispatch");
	const jobs = effect.spec.jobs;
	assert.ok(Array.isArray(jobs));
	assert.deepEqual(
		jobs.map((job) => {
			assert.ok(job && typeof job === "object" && !Array.isArray(job));
			return [job.seat, job.model];
		}),
		[
			["design_prototype", "opt/prototype"],
			["design_prototype", "opt/prototype"],
		],
	);
	for (const [i, job] of jobs.entries()) {
		assert.ok(job && typeof job === "object" && !Array.isArray(job));
		assert.ok(typeof job.question === "string");
		for (const fact of [
			protocol.question,
			protocol.decisionRule,
			...protocol.controls,
			protocol.axis,
			protocol.variants[i]!,
		]) {
			assert.ok(job.question.includes(fact), fact);
		}
		assert.ok(!job.question.includes(protocol.variants[1 - i]!));
	}
	assert.deepEqual(experimentEffect(experiment), effect);
	assert.match(JSON.stringify(experimentEffect(start())), /default\/design/);
});

test("cannot decide before observations arrive or accept a foreign or repeated effect fact", () => {
	const pending = start();
	assert.ok("reject" in recordExperiment(pending, comparison));
	assert.equal(
		finishExperiment(pending, {
			kind: "effect_done",
			key: effectKey("experiment/2"),
			result: { results: receipts },
		}),
		null,
	);
	const complete = settled();
	assert.equal(experimentEffect(complete), null);
	assert.equal(
		finishExperiment(complete, {
			kind: "effect_done",
			key: effectKey("experiment/3"),
			result: { results: receipts },
		}),
		null,
	);
});

test("records the protocol, both receipts and the decision under the named node", () => {
	const observations = settled();
	const input = experimentInput(observations);
	for (const fact of [
		"L1",
		protocol.decisionRule,
		"64 entries",
		"41, 44, 41",
		"22, 23, 21",
	]) {
		assert.ok(input.includes(fact), fact);
	}
	const result = recordExperiment(observations, comparison);
	assert.ok("experiment" in result, JSON.stringify(result));
	const experiment = result.experiment;
	assert.deepEqual(experiment.protocol, protocol);
	assert.deepEqual(experiment.outcome?.results, receipts);
	assert.deepEqual(experiment.comparison, comparison);
	const evidence = experimentEvidence(experiment);
	for (const fact of [
		"L1",
		protocol.question,
		protocol.decisionRule,
		...protocol.controls,
		protocol.axis,
		...protocol.variants,
		"child-a",
		"child-b",
		"Fixture F output: Read counts: 41, 44, 41",
		"Fixture F output: Read counts: 22, 23, 21",
		comparison.comparison,
	]) {
		assert.ok(evidence.includes(fact), fact);
	}
	assert.ok("reject" in recordExperiment(experiment, comparison));
});

test("accepts prototype reports in JSON fences and preserves the winner's unasked decisions", () => {
	const result = recordExperiment(
		settled(
			receipts.map((receipt) => ({
				...receipt,
				answer: `\`\`\`json\n${receipt.answer}\n\`\`\``,
			})),
		),
		comparison,
	);
	assert.ok("experiment" in result);
	assert.deepEqual(experimentDecisions(result.experiment), [
		"Name the cache localBlocks.",
	]);
});

test("requires a reasoned comparison naming a protocol variant or marking the result inconclusive", () => {
	const observations = settled();
	assert.ok(
		"reject" in
			recordExperiment(observations, { ...comparison, winner: "no cache" }),
	);
	assert.ok(
		"reject" in
			recordExperiment(observations, { ...comparison, comparison: "  " }),
	);
	const result = recordExperiment(observations, {
		comparison: "The observations do not establish the rule.",
	});
	assert.ok("experiment" in result);
	assert.equal(result.experiment.comparison?.winner, null);
	assert.match(experimentEvidence(result.experiment), /inconclusive/i);
	assert.deepEqual(experimentDecisions(result.experiment), []);
});

test("retains a failed child beside a successful sibling without treating missing evidence as a win", () => {
	const observations = settled(
		receipts.with(0, {
			...receipts[0]!,
			answer: null,
			error: "Prototype timed out.",
		}),
	);
	assert.ok("reject" in recordExperiment(observations, comparison));
	const result = recordExperiment(observations, {
		comparison: "One variant never answered.",
	});
	assert.ok("experiment" in result);
	const evidence = experimentEvidence(result.experiment);
	assert.match(evidence, /Prototype timed out\./);
	assert.match(evidence, /22, 23, 21/);
});

test("does not select a winner when a child omits its incidental-choice report", () => {
	const observations = settled(
		receipts.with(1, {
			...receipts[1]!,
			answer: '{"observation":"Fewer reads","evidence":"Logs"}',
		}),
	);
	assert.ok("reject" in recordExperiment(observations, comparison));
	assert.match(experimentInput(observations), /incidental choices/i);
	assert.match(experimentInput(observations), /Fewer reads/);
});

test("retains a failed effect or unmatched batch as inconclusive evidence without redispatching", () => {
	for (const [fact, message] of [
		[
			{
				kind: "effect_failed",
				key: effectKey("experiment/3"),
				error: "Cannot prepare a scratch directory.",
			},
			/Cannot prepare a scratch directory/,
		],
		[
			{
				kind: "effect_done",
				key: effectKey("experiment/3"),
				result: { results: receipts.slice(0, 1) },
			},
			/does not match/,
		],
	] as const) {
		const observations = finishExperiment(start(), fact);
		assert.ok(observations);
		assert.equal(experimentEffect(observations), null);
		assert.ok("reject" in recordExperiment(observations, comparison));
		const result = recordExperiment(observations, {
			comparison: "No comparison was possible.",
		});
		assert.ok("experiment" in result);
		assert.match(experimentEvidence(result.experiment), message);
	}
});
