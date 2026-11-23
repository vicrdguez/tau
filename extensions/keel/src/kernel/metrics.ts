import type { Context } from "tau/chord";
import { defineTelemetrySchema } from "tau/telemetry";
import type { Address } from "./records.ts";

function dimension<const V extends readonly string[]>(
	description: string,
	...values: V
) {
	return { type: "string", required: true, description, values } as const;
}

const reviewOutcome = dimension("Final review choice.", "approve", "decline");

export const KEEL_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		"keel.decision.wait": {
			kind: "histogram",
			unit: "ms",
			description: "Time between asking the owner and receiving an answer.",
			attributes: {
				lane: {
					type: "string",
					required: true,
					description: "Lane that asked.",
				},
				choice: {
					type: "string",
					required: true,
					description: "Owner choice, with arena base choices grouped as base.",
				},
			},
		},
		"keel.work.started": {
			kind: "counter",
			unit: "{work}",
			description: "Works accepted at Ground.",
			attributes: {
				route: dimension(
					"Accepted Ground route.",
					"follow",
					"precedent",
					"ambiguous",
				),
			},
		},
		"keel.work.duration": {
			kind: "histogram",
			unit: "ms",
			description: "Time between Ground acceptance and work closure.",
			attributes: {
				outcome: dimension(
					"How the work closed.",
					"accepted",
					"rejected",
					"declined",
					"cancelled",
				),
			},
		},
		"keel.mandate.rounds": {
			kind: "histogram",
			unit: "{round}",
			description: "Answered rounds at the end of Mandate review.",
			attributes: { outcome: reviewOutcome },
		},
		"keel.revision.rounds": {
			kind: "histogram",
			unit: "{round}",
			description: "Answered rounds at the end of live revision review.",
			attributes: { outcome: reviewOutcome },
		},
		"keel.arena.seat": {
			kind: "counter",
			unit: "{receipt}",
			description: "Settled arena seat receipts.",
			attributes: {
				stage: dimension("Arena stage.", "candidates", "judge", "challenger"),
				model: {
					type: "string",
					required: true,
					description: "Pinned provider/modelId.",
				},
				outcome: dimension("Seat result.", "ok", "error"),
			},
		},
		"keel.item.attempts": {
			kind: "histogram",
			unit: "{attempt}",
			description: "Number of attempts by the time an item merges.",
			attributes: { kind: dimension("Plan item kind.", "build", "encode") },
		},
		"keel.verdict": {
			kind: "counter",
			unit: "{verdict}",
			description: "Accepted verification verdicts.",
			attributes: {
				scope: dimension("Verification scope.", "item", "full", "landing"),
				outcome: dimension("Verification outcome.", "pass", "fail"),
			},
		},
		"keel.item.reviews": {
			kind: "histogram",
			unit: "{review}",
			description: "Number of item verdicts by the time an item passes.",
			attributes: {},
		},
		"keel.integration": {
			kind: "counter",
			unit: "{integration}",
			description: "Settled integration attempts.",
			attributes: {
				result: dimension(
					"Integration result.",
					"merged",
					"combined",
					"conflict",
					"checks_failed",
				),
			},
		},
		"keel.landing": {
			kind: "counter",
			unit: "{landing}",
			description: "Successful landing results.",
			attributes: {
				result: dimension("Landing result.", "landed", "unchanged"),
			},
		},
		"keel.hold": {
			kind: "counter",
			unit: "{hold}",
			description: "Work or item holds opened by a lane.",
			attributes: {
				lane: dimension(
					"Lane that opened the hold.",
					"design",
					"build",
					"verify",
				),
				cause: dimension(
					"Reason for the hold.",
					"failed",
					"stopped",
					"unfulfilled",
					"moved",
					"occupied",
					"stall",
					"waiting",
					"kept",
					"effect_failed",
					"nonconvergent",
				),
			},
		},
		"keel.finding": {
			kind: "counter",
			unit: "{finding}",
			description: "Findings classified by investigation.",
			attributes: {
				class: dimension(
					"Finding class.",
					"defect_in_scope",
					"determined",
					"sets_precedent",
					"mandate_wrong",
					"unapproved_pattern",
					"no_action",
				),
			},
		},
	},
} as const);

type Metrics = typeof KEEL_TELEMETRY_SCHEMA.metrics;
type Attributes<A> = keyof A extends never
	? Record<string, never>
	: {
			[K in keyof A]: A[K] extends { values: readonly (infer V)[] }
				? V
				: string;
		};

export type Measure = {
	[N in keyof Metrics]: {
		name: N;
		value: number;
		attributes: Attributes<Metrics[N]["attributes"]>;
	};
}[keyof Metrics];

export function record(
	context: Context,
	measures: readonly Measure[],
	address?: Address,
): void {
	try {
		if (address) {
			const { lane, work } = address;
			context.telemetry.setAttributes({
				"keel.lane": lane,
				...(work !== null && { "keel.work": String(work) }),
			});
		}
		const metrics = context.telemetry.metrics;
		if (!metrics) return;
		for (const { name, value, attributes } of measures) {
			const { kind, unit, description } = KEEL_TELEMETRY_SCHEMA.metrics[name];
			if (kind === "counter")
				metrics.counter(name, { unit, description }).add(value, attributes);
			else
				metrics
					.histogram(name, { unit, description })
					.record(value, attributes);
		}
	} catch {}
}
