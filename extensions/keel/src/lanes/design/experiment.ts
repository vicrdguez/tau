import { arr, compile, obj, opt } from "tau/schema";
import { effectKey } from "../../kernel/ids.ts";
import {
	defineLaneTool,
	type EffectDecl,
	type KernelEvent,
	prose,
	type StaticFacts,
} from "../../kernel/lane.ts";
import { text } from "./draft.ts";
import { replyJson } from "./reply-json.ts";

// An experiment is a single bounded dispatch batch.
const maxVariants = 8;
const seat = "design_prototype";
const protocolSchema = obj({
	node: text,
	question: text,
	decisionRule: text,
	controls: arr(text, { minItems: 1 }),
	axis: text,
	variants: arr(text, { minItems: 2, maxItems: maxVariants }),
});
const comparisonSchema = obj({ comparison: text, winner: opt(text) });
const prototypeReport = compile(
	obj({ observation: text, evidence: text, incidentalChoices: arr(text) }),
);

export const experimentTools = [
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "start_experiment",
		description:
			"Name the Mandate node and write an observable question, decision rule and controls. For repository code, include the source path and revision among the controls. Give two to eight variants of a single axis. Keel starts one prototype per variant.",
		parameters: protocolSchema,
		terminate: true,
		event: (args) => ({ kind: "start_experiment", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "record_experiment",
		description:
			"Record the comparison under the experiment's node by applying its written decision rule. Include the exact winning variant, or omit the winner if inconclusive.",
		parameters: comparisonSchema,
		terminate: true,
		event: (args) => ({
			kind: "record_experiment",
			comparison: args.comparison,
			...(args.winner !== undefined && { winner: args.winner }),
		}),
	}),
];

export type ExperimentProtocol = {
	node: string;
	question: string;
	decisionRule: string;
	controls: string[];
	axis: string;
	variants: string[];
};
export type ExperimentComparison = { comparison: string; winner?: string };
type Receipt = {
	seat: typeof seat;
	conversation: string;
	answer: string | null;
	error: string | null;
};
export type Experiment = {
	id: number;
	protocol: ExperimentProtocol;
	jobs: { seat: typeof seat; model: string; question: string }[];
	outcome: { results: Receipt[]; error: string | null } | null;
	comparison: { comparison: string; winner: string | null } | null;
};

type Update = { experiment: Experiment } | { reject: string };
type EffectFact = Extract<
	KernelEvent,
	{ kind: "effect_done" | "effect_failed" }
>;

const dir = `${import.meta.dirname}/../../prose`;
const runPrototype = prose(dir, "inputs/design/run-prototype.md", [
	"question",
	"decisionRule",
	"controls",
	"axis",
	"variant",
]);
const comparePrototypes = prose(dir, "inputs/design/compare-experiment.md", [
	"evidence",
]);
const renderEvidence = prose(dir, "documents/experiment-evidence.md", [
	"id",
	"node",
	"question",
	"decisionRule",
	"controls",
	"axis",
	"variants",
	"results",
	"decision",
]);

const written = (value: string) => !!value.trim();
const label = (value: string) =>
	written(value) && value === value.trim() && !/[\r\n]/.test(value);
const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
const key = (experiment: Experiment) =>
	effectKey(`experiment/${experiment.id}`);

/** A fresh id within this work pins one protocol and its immutable dispatch plan. */
export function startExperiment(
	id: number,
	protocol: ExperimentProtocol,
	options: Pick<StaticFacts["options"], "design" | "design_prototype">,
): Update {
	const { node, question, decisionRule, controls, axis, variants } = protocol;
	if (!written(decisionRule))
		return { reject: "Write the decision rule before starting a prototype." };
	if (
		!label(node) ||
		!written(question) ||
		!written(axis) ||
		!controls.length ||
		!controls.every(written)
	)
		return {
			reject:
				"Name the Mandate node, observable question, shared controls and one axis.",
		};
	if (
		variants.length < 2 ||
		variants.length > maxVariants ||
		!variants.every(label) ||
		new Set(variants).size !== variants.length
	)
		return {
			reject: `Give two to ${maxVariants} distinct variants on the one named axis.`,
		};
	const model = options.design_prototype ?? options.design;
	return {
		experiment: {
			id,
			protocol: {
				node,
				question,
				decisionRule,
				controls: [...controls],
				axis,
				variants: [...variants],
			},
			jobs: variants.map((variant) => ({
				seat,
				model,
				question: runPrototype({
					question,
					decisionRule,
					controls: list(controls),
					axis,
					variant,
				}),
			})),
			outcome: null,
			comparison: null,
		},
	};
}

export function experimentEffect(experiment: Experiment): EffectDecl | null {
	return experiment.outcome === null
		? {
				key: key(experiment),
				interruptible: true,
				spec: { kind: "arena_dispatch", jobs: experiment.jobs },
			}
		: null;
}

function readReceipts(value: unknown, expected: number): Receipt[] | null {
	if (!Array.isArray(value) || value.length !== expected) return null;
	const receipts: Receipt[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object" || Array.isArray(row)) return null;
		const { seat: role, conversation, answer, error } = row;
		if (
			role !== seat ||
			typeof conversation !== "string" ||
			!written(conversation) ||
			(answer !== null && typeof answer !== "string") ||
			(error !== null && typeof error !== "string")
		)
			return null;
		receipts.push({ seat, conversation, answer, error });
	}
	return receipts;
}

/** Consume only the outstanding fact. Finished and cancelled runs are not redeclared by the lane. */
export function finishExperiment(
	experiment: Experiment,
	fact: EffectFact,
): Experiment | null {
	if (experiment.outcome !== null || fact.key !== key(experiment)) return null;
	if (fact.kind === "effect_failed")
		return { ...experiment, outcome: { results: [], error: fact.error } };
	const results = readReceipts(fact.result.results, experiment.jobs.length);
	return {
		...experiment,
		outcome: results
			? { results, error: null }
			: {
					results: [],
					error:
						"The dispatch result does not match the planned prototype variants.",
				},
	};
}

function report(receipt: Receipt) {
	if (receipt.error !== null || !receipt.answer?.trim()) return null;
	const parsed = prototypeReport.validate(replyJson(receipt.answer));
	if (!parsed.ok) return null;
	const { observation, evidence, incidentalChoices } = parsed.value;
	return written(observation) &&
		written(evidence) &&
		incidentalChoices.every(written)
		? parsed.value
		: null;
}

export function recordExperiment(
	experiment: Experiment,
	comparison: ExperimentComparison,
): Update {
	const outcome = experiment.outcome;
	if (!outcome)
		return {
			reject: "Wait for the prototype results before recording a comparison.",
		};
	if (experiment.comparison)
		return { reject: "This experiment already has a recorded comparison." };
	if (!written(comparison.comparison))
		return {
			reject: "Explain the comparison against the written decision rule.",
		};
	const winner = comparison.winner ?? null;
	if (winner !== null) {
		if (!experiment.protocol.variants.includes(winner))
			return {
				reject: "Name the exact winning protocol variant or omit the winner.",
			};
		if (outcome.error !== null || !outcome.results.every(report))
			return {
				reject:
					"Not every prototype returned a usable report. Record why the result is inconclusive.",
			};
	}
	return {
		experiment: {
			...experiment,
			comparison: { comparison: comparison.comparison, winner },
		},
	};
}

function resultsText(experiment: Experiment) {
	const outcome = experiment.outcome;
	if (!outcome) return "Not returned yet.";
	if (outcome.error !== null) return outcome.error;
	return outcome.results
		.map((receipt, i) => {
			const heading = `**${experiment.protocol.variants[i]}** (conversation ${receipt.conversation})`;
			const parsed = report(receipt);
			return [
				heading,
				...(parsed
					? [
							`Observation: ${parsed.observation}`,
							`Evidence: ${parsed.evidence}`,
							`Unasked decisions:\n\n${parsed.incidentalChoices.map((choice, i) => `${i + 1}. ${choice}`).join("\n") || "None."}`,
						]
					: [
							receipt.error ??
								(receipt.answer?.trim()
									? "The prototype did not report an observation, evidence and incidental choices in the required format."
									: "The prototype returned no answer."),
							...(receipt.answer ? [`Raw answer:\n\n${receipt.answer}`] : []),
						]),
			].join("\n\n");
		})
		.join("\n\n");
}

/** Render from the original experiment, outside the binding Mandate. */
export function experimentEvidence(experiment: Experiment): string {
	const { protocol, comparison } = experiment;
	return renderEvidence({
		...protocol,
		id: String(experiment.id),
		controls: list(protocol.controls),
		variants: list(protocol.variants),
		results: resultsText(experiment),
		decision: comparison
			? `${comparison.winner ?? "Inconclusive"}. ${comparison.comparison}`
			: "Not recorded yet.",
	});
}

export function experimentInput(experiment: Experiment): string {
	return comparePrototypes({ evidence: experimentEvidence(experiment) });
}

export function experimentDecisions(experiment: Experiment) {
	const winner = experiment.comparison?.winner;
	if (winner == null) return [];
	const receipt =
		experiment.outcome?.results[experiment.protocol.variants.indexOf(winner)];
	return receipt ? (report(receipt)?.incidentalChoices ?? []) : [];
}
