export type Mandate = {
	/** Set only by an owner review, never by the draft submitted to Ground. */
	reviewed: boolean;
	encodeRequired: boolean;
	approvalNotes: string[];
	intent: string;
	nodes: { label: string; rule: string; probe: string }[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	protectedPaths: string[];
};
export function mandateLabels(mandate: Mandate) {
	return [
		"intent",
		"protectedPaths",
		...mandate.nodes.map((n) => n.label),
		...mandate.checks.map((c) => c.id),
	];
}
