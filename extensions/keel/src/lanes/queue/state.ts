import type { WorkId } from "../../kernel/ids.ts";
import type { World } from "../../kernel/lane.ts";
import type { Mandate } from "../design/public.ts";
import type { Intake } from "./public.ts";

export const classes = [
	"defect_in_scope",
	"determined",
	"sets_precedent",
	"mandate_wrong",
	"unapproved_pattern",
	"duplicate",
	"no_action",
] as const;
export type Classification = (typeof classes)[number];
export const workChoices = ["build", "defer", "drop"] as const;
export const patternChoices = ["bless", "revoke", "defer"] as const;
export type Investigation = {
	classification: Classification;
	nodes: string[];
	evidence: string;
	size: string;
	cause: string;
	recommendation: string;
	reference: string | null;
	duplicateOf: number | null;
};
export type Investigated = {
	kind: "investigated";
	finding: number;
	sameAs: number | null;
} & Investigation;
export type PlanItem = {
	id: string;
	goal: string;
	stage: string;
	nodes: string[];
	deps: string[];
};
export type QueueBuildView = {
	phase: string;
	plan: PlanItem[];
	itemOf(agent: string): string | null;
};
export function context(world: World, work: WorkId | null) {
	const build =
		work === null ? null : (world.view("build", work) as QueueBuildView | null);
	const design =
		work === null
			? null
			: (world.view("design", work) as {
					mandate: Mandate | null;
					reference: string | null;
				} | null);
	return {
		active: build?.phase === "active",
		phase: build?.phase ?? "missing",
		plan:
			build?.plan.map(({ id, goal, stage, nodes, deps }) => ({
				id,
				goal,
				stage,
				nodes,
				deps,
			})) ?? [],
		mandate: design?.mandate ?? null,
		reference: design?.reference ?? null,
	};
}

export type Status =
	| "filed"
	| "triage"
	| "routed"
	| "dropped"
	| "deferred"
	| "duplicate"
	| "blessed"
	| "cancelled"
	| "revision_pending"
	| "no_action"
	| "revision_declined"
	| "settled";
export type Finding = {
	id: number;
	intake: Intake;
	basis: string | null;
	status: Status;
	investigation: Investigation | null;
	batch: number | null;
	disposition: string | null;
};
export type Queue = {
	entries: Finding[];
	patterns: {
		name: string;
		finding: number;
		evidence: string;
		status: "blessed" | "revoked";
	}[];
	context: string;
	attempt: number;
	direction: string;
	stall: { cause: string; lastWords: string } | null;
};
export const initial = (): Queue => ({
	entries: [],
	patterns: [],
	context: "",
	attempt: 0,
	direction: "",
	stall: null,
});
export const pending = (q: Queue) =>
	q.entries.find((f) => f.status === "filed");
export const cause = (f: Finding) => `queue/${f.id}`;
export function update(q: Queue, f: Finding, changes: Partial<Finding>): Queue {
	return {
		...q,
		entries: q.entries.map((entry) =>
			entry === f ? { ...entry, ...changes } : entry,
		),
	};
}

export function choices(classification: Classification) {
	return classification === "no_action"
		? (["no_action"] as const)
		: classification === "unapproved_pattern"
			? patternChoices
			: workChoices;
}

export function batches(q: Queue) {
	const open = new Map<number, Finding[]>();
	for (const f of q.entries) {
		if (f.status !== "triage" || f.batch === null) continue;
		const batch = open.get(f.batch);
		if (batch) batch.push(f);
		else open.set(f.batch, [f]);
	}
	return [...open.values()];
}
export function duplicates(q: Queue, batch: readonly Finding[]) {
	return q.entries.filter(
		(f) =>
			f.status === "duplicate" &&
			batch.some((b) => b.id === f.investigation?.duplicateOf),
	);
}
