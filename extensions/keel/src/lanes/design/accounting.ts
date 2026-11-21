import { arr, int, obj, opt } from "tau/schema";
import {
	type Arena,
	candidateDecisions,
	candidateNames,
	candidateUnasked,
	quote,
} from "./arena.ts";
import { type Audit, nodes, reviewedDraft, text } from "./draft.ts";
import { type Experiment, experimentDecisions } from "./experiment.ts";
import { nodeBody } from "./public.ts";
import type { Synthesis } from "./rounds.ts";

export const synthesisParts = {
	draft: reviewedDraft,
	grafts: arr(obj({ seat: text, label: text, text })),
	outcomes: arr(
		obj({
			source: text,
			n: int({ minimum: 1 }),
			label: opt(text),
			reason: opt(text),
		}),
	),
};

export type Outcome = {
	source: string;
	n: number;
} & ({ label: string } | { reason: string });

type Source = { id: string; decisions: string[]; own?: string };
export function unaskedSources(
	arena: Arena,
	s: Synthesis,
	experiments: Experiment[],
): Source[] {
	return [
		...[...new Set([s.base, ...s.grafts.map((g) => g.seat)])].map((seat) => ({
			id: seat,
			decisions: candidateDecisions(arena, seat),
			own: candidateUnasked(arena, seat),
		})),
		...experiments
			.map((e) => ({
				id: `experiment-${e.id}`,
				decisions: experimentDecisions(e),
			}))
			.filter((e) => e.decisions.length),
	];
}
export function accountingError(
	audit: Audit,
	arena: Arena,
	s: Synthesis,
	experiments: Experiment[],
	newExperiments: Experiment[],
) {
	const seats: readonly string[] = candidateNames(arena);
	if (!seats.includes(s.base)) return "Choose an arena candidate as base.";
	if (arena.forcedBase !== null && s.base !== arena.forcedBase)
		return `Use ${arena.forcedBase} as the base, as the owner chose.`;
	const nodeLabels = new Set(
		nodes(s.draft, audit, "Proposed ruling").map((n) => n.label),
	);
	const riderLabels = new Set(s.draft.riders.map((r) => r.label));
	if (
		!Array.isArray(s.grafts) ||
		s.grafts.some(
			(g) =>
				!seats.includes(g.seat) ||
				g.seat === s.base ||
				!g.text?.trim() ||
				(!nodeLabels.has(g.label) && !riderLabels.has(g.label)),
		)
	)
		return "Attribute each graft to another candidate and name the Mandate label it became.";
	for (const experiment of newExperiments)
		if (experiment.comparison && !nodeLabels.has(experiment.protocol.node))
			return `Include the Mandate node ${experiment.protocol.node} for the recorded experiment.`;
	if (!Array.isArray(s.outcomes))
		return "Supply the unasked-decision outcomes.";
	const sources = unaskedSources(arena, s, experiments);
	for (const { id, decisions } of sources) {
		for (const [i] of decisions.entries()) {
			const [outcome, ...extra] = s.outcomes.filter(
				(o) => o.source === id && o.n === i + 1,
			);
			if (!outcome || extra.length)
				return `Give exactly one outcome for unasked decision ${i + 1} from ${id}.`;
			const valid =
				"label" in outcome
					? !("reason" in outcome) &&
						(nodeLabels.has(outcome.label) || riderLabels.has(outcome.label))
					: !!outcome.reason?.trim();
			if (!valid)
				return `Give unasked decision ${i + 1} from ${id} a real node or rider label, or explain why it was not taken.`;
		}
	}
	if (
		s.outcomes.length !==
		sources.reduce((n, src) => n + src.decisions.length, 0)
	)
		return "An outcome names an unknown unasked decision.";
	return null;
}

export function outcomesText(audit: Audit, s: Synthesis, sources: Source[]) {
	const entries = nodes(s.draft, audit, "Proposed ruling");
	return sources
		.map(({ id, decisions, own }) => {
			const list = decisions
				.map((d, i) => {
					const o = s.outcomes.find((o) => o.source === id && o.n === i + 1)!;
					if (!("label" in o))
						return `${i + 1}. ${d}\n   Not taken: ${o.reason}`;
					const rider = s.draft.riders.find((r) => r.label === o.label);
					const body = rider
						? `${rider.text}\n\nDisposition: ${rider.disposition}`
						: nodeBody(entries.find((n) => n.label === o.label)!);
					return `${i + 1}. ${d}\n   ${rider ? "Rider" : "Node"} \`${o.label}\`\n\n${quote(body).replace(/^/gm, " ".repeat(String(i + 1).length + 2))}`;
				})
				.join("\n\n");
			return (
				`### ${id}\n\n` +
				(own
					? `Candidate's unasked decisions:\n\n${quote(own)}\n\nJudge's list and outcomes:\n\n`
					: "") +
				(list || "None reported.")
			);
		})
		.join("\n\n");
}
