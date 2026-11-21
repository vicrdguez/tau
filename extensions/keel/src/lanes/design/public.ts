import { arr, int, obj, oneOf, str } from "tau/schema";
import type { WorkId } from "../../kernel/ids.ts";
import { prose } from "../../kernel/lane.ts";
import type { Draft } from "./draft.ts";

export const repliesSchema = arr(
	obj({
		n: int({ minimum: 1 }),
		status: oneOf(["acted_on", "considered", "dismissed"]),
		reason: str({ minLength: 1 }),
	}),
);
export type Reply = {
	n: number;
	status: "acted_on" | "considered" | "dismissed";
	reason: string;
};

/** Both a revision and the first plan settle an answer's contiguous annotation numbers. */
export function repliesCover(count: number, replies: Reply[]) {
	return (
		replies.length === count &&
		new Set(replies.map((r) => r.n)).size === count &&
		replies.every(
			(r) =>
				Number.isSafeInteger(r.n) &&
				r.n >= 1 &&
				r.n <= count &&
				["acted_on", "considered", "dismissed"].includes(r.status) &&
				!!r.reason.trim(),
		)
	);
}

export type RiderOrigin = "evidence" | "incidental" | "seeded";
export type Mandate = {
	encodeRequired: boolean;
	approvalNotes: string[];
	intent: string;
	delegated: { label: string; text: string; origin: RiderOrigin }[];
	nodes: (
		| { label: string; rule: string; probe: string }
		| { label: string; section: string; body: string }
		| {
				label: string;
				section: string;
				body: string;
				seam: Draft["seams"][number];
		  }
	)[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	/** Design context, not authority for briefs. Null in a small Mandate. */
	considerations: { tradeoffs: string; alternatives: string } | null;
};
export function explorerDesign(view: unknown) {
	const design = view as {
		unavailable: boolean;
		goal: string;
		mandate: Mandate | null;
		ownerReviewed: boolean;
		revisedLabels: string[];
	} | null;
	return design?.unavailable ? null : design;
}
export function reviewedHistory(view: unknown) {
	const prior = explorerDesign(view);
	if (!prior?.mandate) return null;
	const mandate = prior.ownerReviewed ? prior.mandate : null;
	const nodes = mandateNodes(prior.mandate).filter(
		(n) => mandate || prior.revisedLabels.includes(n.label),
	);
	return mandate || nodes.length
		? { mandate, nodes, goal: mandate ? prior.goal : "Reviewed revision only" }
		: null;
}
const firstLine = (text: string) => text.trim().split(/\r?\n/, 1)[0]!.trim();
export function authorityIndex(
	work: WorkId,
	history: NonNullable<ReturnType<typeof reviewedHistory>>,
) {
	return {
		work,
		goal: firstLine(history.goal),
		revisionOnly: !history.mandate,
		nodes: history.nodes.map(({ label, body }) => ({
			label,
			line: firstLine(body),
		})),
	};
}
export type AuthorityIndex = ReturnType<typeof authorityIndex>;

export function mandateLabels(mandate: Mandate) {
	return [
		"intent",
		...mandate.nodes.map((n) => n.label),
		...mandate.checks.map((c) => c.id),
	];
}

const dir = import.meta.dirname + "/../../prose/documents";
const proof = prose(dir, "proof-command.md", ["argv", "timeout"]);
export const proofText = ({ argv, timeoutMs }: Mandate["checks"][number]) =>
	proof({ argv: JSON.stringify(argv), timeout: String(timeoutMs) }).trim();
const boundMandate = prose(dir, "bound-mandate.md", [
	"nodes",
	"delegated",
	"considerations",
]);
const considerationsText = prose(dir, "design-considerations.md", [
	"tradeoffs",
	"alternatives",
]);

/** The common review representation of a bound or draft Mandate node. */
export type MandateNode = {
	label: string;
	section: string;
	body: string;
	probe?: string;
	seam?: Draft["seams"][number] | undefined;
	check?: Mandate["checks"][number] | undefined;
	rider?: Draft["riders"][number];
	reference?: string;
};
export function mandateNodes(m: Mandate): MandateNode[] {
	return [
		{ label: "intent", section: "Intent", body: m.intent },
		...m.nodes.map((n) =>
			"rule" in n
				? { label: n.label, section: "Rule", body: n.rule, probe: n.probe }
				: n,
		),
		...m.checks.map((check) => ({
			label: check.id,
			section: "Proof",
			body: proofText(check),
			check,
		})),
	];
}
function nodeFields(n: MandateNode) {
	const { seam, check, rider } = n;
	return {
		section: n.section,
		...(seam
			? {
					"current callers": seam.callersNow,
					"future callers": seam.callersLater,
					"caller usage": seam.usage,
					"types and signatures": seam.signature,
					owner: seam.owner,
					"allowed dependencies": seam.dependencies,
				}
			: check
				? { command: check.argv, timeout: check.timeoutMs }
				: rider
					? {
							text: rider.text,
							origin: rider.origin,
							disposition: rider.disposition,
						}
					: {
							[n.label === "intent"
								? "intent"
								: n.section === "Rule"
									? "rule"
									: "text"]: n.body,
							[n.label === "intent" ? "done when" : "falsifying probe"]:
								n.probe || undefined,
						}),
		reference: n.reference,
	};
}
export function changedFields(old: MandateNode, next: MandateNode) {
	const before: Record<string, unknown> = nodeFields(old);
	const after: Record<string, unknown> = nodeFields(next);
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
		(field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
	);
}
export function nodeBody(n: MandateNode) {
	return [
		n.body,
		...(n.probe
			? [
					`${n.label === "intent" ? "Done when" : "Falsifying probe"}: ${n.probe}`,
				]
			: []),
		...(n.reference ? [`Reference: ${n.reference}`] : []),
	].join("\n\n");
}
export function renderNode(
	n: MandateNode,
	mark = "",
	fields: string[] = [],
	heading = "###",
) {
	const changes = fields.length ? `Changed: ${fields.join(", ")}\n\n` : "";
	return `${heading} ${n.label}: ${n.section}${mark}\n\n${changes}${nodeBody(n)}`;
}

/** Render the complete bound document, or only the binding labels named by a brief. */
export function renderMandate(m: Mandate, labels?: readonly string[]) {
	const nodes = mandateNodes(m)
		.filter((n) => !labels || labels.includes(n.label))
		.map((n) => renderNode(n, "", [], labels ? "###" : "####"))
		.join("\n\n");
	return labels
		? nodes
		: boundMandate({
				nodes,
				delegated:
					m.delegated
						.map((r) => `- ${r.label} (${r.origin}): ${r.text}`)
						.join("\n") || "None.",
				considerations: m.considerations
					? considerationsText(m.considerations)
					: "",
			});
}
