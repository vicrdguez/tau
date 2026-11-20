import { arr, int, obj, oneOf, str } from "tau/schema";

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

export type Mandate = {
	/** Set only by an owner review, never by the draft submitted to Ground. */
	reviewed: boolean;
	encodeRequired: boolean;
	approvalNotes: string[];
	intent: string;
	delegated: { label: string; text: string }[];
	nodes: (
		| { label: string; rule: string; probe: string }
		| { label: string; section: string; body: string }
	)[];
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
