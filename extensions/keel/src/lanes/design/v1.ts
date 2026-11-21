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
type ArenaSeat = {
	seat:
		| "arena_seat_1"
		| "arena_seat_2"
		| "arena_seat_3"
		| "arena_judge"
		| "arena_challenger";
	model: string;
};
type Arena = {
	frame: { question: string; rubric: string };
	judge: string;
	challenger: string;
	refusal: string | null;
	runs: {
		stage: "candidates" | "judge" | "challenger";
		jobs: (ArenaSeat & { question: string })[];
		outcome: {
			results: {
				seat: ArenaSeat["seat"];
				conversation: string;
				answer: string | null;
				error: string | null;
			}[];
			error: string | null;
		} | null;
	}[];
	forcedBase: string | null;
};
type Experiment = {
	id: number;
	protocol: {
		node: string;
		question: string;
		decisionRule: string;
		controls: string[];
		axis: string;
		variants: string[];
	};
	jobs: { seat: "design_prototype"; model: string; question: string }[];
	outcome: {
		results: {
			seat: "design_prototype";
			conversation: string;
			answer: string | null;
			error: string | null;
		}[];
		error: string | null;
	} | null;
	comparison: { comparison: string; winner: string | null } | null;
};
type Synthesis = {
	draft: Draft;
	replies: Reply[];
	base: string;
	grafts: { seat: string; label: string; text: string }[];
	outcomes: ({ source: string; n: number } & (
		| { label: string }
		| { reason: string }
	))[];
	experimentCount: number;
};
type DesignerPhase =
	| "seeded"
	| "directed"
	| "resumed"
	| "framing"
	| "drafting"
	| "answering"
	| "experiment_comparing";
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
			| DesignerPhase
			| "entry"
			| "ambiguous"
			| "held"
			| "bound"
			| "dispatching"
			| "experiment_running"
			| "arena_blocked"
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
			owed: number[];
			route: "follow" | "precedent";
			reference: string | null;
			text: string;
		} | null,
		arenas: [] as Arena[],
		experiments: [] as Experiment[],
		experimentReturn: null as "framing" | "drafting" | null,
		proposal: null as Synthesis | null,
		rounds: [] as (Synthesis & {
			arena: number;
			challenge: number;
			dispositions: Reply[];
			answer: Answer | null;
		})[],
		revisions: [] as {
			phase:
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
				answers: { cause: string; nodes: string[]; reason: string }[];
				changes: string;
				replies: Reply[];
				plan: string;
				answer: Answer | null;
			}[];
		}[],
		cancelRequested: false,
		cleanup: null as {
			build: string[] | null;
			verify: string[] | null;
			dispatch: { key: string; stopped: boolean } | null;
		} | null,
		reference: "",
		mandate: null as Mandate | null,
		readings: [] as string[],
		direction: "",
		cause: null as string | null,
		heldTurn: null as DesignerPhase | null,
		seq: 0,
	}),
};
