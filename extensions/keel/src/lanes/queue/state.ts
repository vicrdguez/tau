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
	sameAs: number | null;
};
export type Investigated = Investigation & {
	kind: "investigated";
	finding: number;
};
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
	plannedFor?(cause: string): string[];
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
					goal?: string;
					reference: string | null;
				} | null);
	return {
		active: build?.phase === "active",
		plan: build?.plan ?? [],
		plannedFor: build?.plannedFor,
		goal: (design?.goal ?? design?.mandate?.intent)?.split("\n", 1)[0] ?? null,
		mandate: design?.mandate ?? null,
		reference: design?.reference ?? null,
	};
}

export type Finding = {
	id: number;
	intake: Omit<Intake, "missingCheck" | "principle"> & {
		missingCheck: true | null;
		principle: true | null;
	};
	goal: string | null;
	basis: string | null;
	status: "filed" | "triage" | "defect" | "revision" | "closed";
	investigation: Investigation | null;
	// An open decision's first finding, or the finding whose fix holds this filer.
	group: number | null;
	disposition: string | null;
	deferredAt: number | null;
	triageDirection: string;
	revisit: boolean;
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

export function decisions(q: Queue) {
	return q.entries.filter((f) => f.status === "triage" && f.basis !== null);
}

export const decisionMembers = (q: Queue, id: number) =>
	q.entries.filter((f) => f.status === "triage" && f.group === id);

export function disposition(f: Finding): string {
	switch (f.status) {
		case "filed":
			return "open: awaiting investigation";
		case "triage":
			return "open: awaiting triage";
		case "revision":
			return "build: awaiting Mandate revision";
		case "defect":
			return f.investigation?.classification === "determined"
				? "open: awaiting planned fix"
				: "open: awaiting defect fix";
		case "closed":
			return f.disposition!;
	}
}

export const close = (disposition: string) =>
	({ status: "closed", basis: null, group: null, disposition }) as const;
