import { arr, int, obj, oneOf, str } from "tau/schema";
import { prose } from "../../kernel/lane.ts";

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
	)[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	/** Design context, not authority for briefs. Null in a small Mandate. */
	considerations: { tradeoffs: string; alternatives: string } | null;
};
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

/** Render the complete bound document, or only the binding labels named by a brief. */
export function renderMandate(m: Mandate, labels?: readonly string[]) {
	const rows = [
		{ label: "intent", section: "Intent", body: m.intent },
		...m.nodes.map((n) =>
			"rule" in n
				? {
						label: n.label,
						section: "Rule",
						body: `${n.rule}\n\nFalsifying probe: ${n.probe}`,
					}
				: n,
		),
		...m.checks.map((c) => ({
			label: c.id,
			section: "Proof",
			body: proofText(c),
		})),
	];
	const nodes = rows
		.filter((n) => !labels || labels.includes(n.label))
		.map(
			(n) => `${labels ? "###" : "####"} ${n.label}: ${n.section}\n\n${n.body}`,
		)
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
