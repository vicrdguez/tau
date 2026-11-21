// Independent version-one storage contract. Keep this shape when adding a migration.
type Observation = { label: string; text: string };
type Draft = {
	intent: string;
	done: string;
	nodes: { label: string; rule: string; probe: string }[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
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
		disposition: "bind" | "open";
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
		excerpt: string | null;
	}[];
};
type Reply = {
	n: number;
	status: "acted_on" | "considered" | "dismissed";
	reason: string;
};
type Mandate = {
	encodeRequired: boolean;
	approvalNotes: string[];
	intent: string;
	delegated: {
		label: string;
		text: string;
		origin: "evidence" | "incidental" | "seeded";
	}[];
	nodes: (
		| { label: string; rule: string; probe: string }
		| { label: string; section: string; body: string }
	)[];
	checks: { id: string; argv: string[]; timeoutMs: number }[];
	considerations: { tradeoffs: string; alternatives: string } | null;
};
export const designV1 = {
	version: 1,
	sample: () => ({
		phase: "entry" as
			| "entry"
			| "seeded"
			| "ambiguous"
			| "directed"
			| "resumed"
			| "held"
			| "bound"
			| "drafting"
			| "review"
			| "landed"
			| "closed"
			| "cancelled",
		audit: null as {
			exists: string;
			gaps: Observation[];
			contradictions: Observation[];
		} | null,
		seed: null as {
			route: "follow" | "precedent";
			reference: string | null;
			text: string;
		} | null,
		rounds: [] as { draft: Draft; replies: Reply[]; answer: Answer | null }[],
		revisions: [] as {
			phase:
				| "queued"
				| "drafting"
				| "review"
				| "held"
				| "approved"
				| "applied"
				| "declined";
			causes: string[];
			nodes: string[];
			text: string;
			rounds: {
				mandate: Mandate;
				nodes: string[];
				replies: Reply[];
				answer: Answer | null;
			}[];
		}[],
		cancelRequested: false,
		cleanup: null as { build: string[] | null; verify: string[] | null } | null,
		reference: "",
		mandate: null as Mandate | null,
		readings: [] as string[],
		direction: "",
		cause: null as string | null,
		seq: 0,
	}),
};
