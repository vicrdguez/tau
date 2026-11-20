// Independent version-one storage contract. Keep this shape when adding a migration.
type Observation = { label: string; text: string };
type Draft = {
	intent: string;
	done: string;
	nodes: { label: string; rule: string; probe: string }[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	protectedPaths: string[];
	never: string;
	tradeoffs: string;
	alternatives: string;
	seams: {
		label: string;
		callersNow: string;
		callersLater: string;
		usage: string;
		signature: string;
		owner: string;
		dependencies: string;
	}[];
	settlements: { label: string; ruling: string }[];
	riders: {
		label: string;
		text: string;
		origin: "evidence" | "incidental" | "seeded";
	}[];
	references: { label: string; source: string }[];
};
type Answer = {
	decision: string;
	choice: string;
	annotations: {
		n: number;
		text: string;
		range: { start: number; end: number } | null;
	}[];
};
export const designV1 = {
	version: 1,
	sample: () => ({
		phase: "entry" as
			| "entry"
			| "ambiguous"
			| "directed"
			| "resumed"
			| "held"
			| "bound"
			| "drafting"
			| "review"
			| "closed"
			| "cancelled",
		audit: null as {
			exists: string;
			gaps: Observation[];
			contradictions: Observation[];
		} | null,
		rounds: [] as {
			draft: Draft;
			labels: string[];
			replies: {
				n: number;
				status: "acted_on" | "considered" | "dismissed";
				reason: string;
			}[];
			answer: Answer | null;
			riders: { label: string; answer: Answer | null }[];
		}[],
		cancelRequested: false,
		cleanup: null as { build: string[] | null; verify: string[] | null } | null,
		reference: "",
		mandate: null as null | {
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
		},
		readings: [] as string[],
		direction: "",
		cause: null as string | null,
		seq: 0,
	}),
};
