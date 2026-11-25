import { defineState } from "../../kernel/state.ts";
import type {
	ProjectPrincipleFile,
	RepoInfo,
	Sha,
	Worker,
} from "../../repo/index.ts";
import { type Mandate, type Reply, repliesCover } from "../design/public.ts";
import type {
	Approval,
	PlanFinding,
	RevisionProposal,
	Ruling,
} from "./public.ts";

export type Goal = {
	id: string;
	kind: "build" | "encode";
	goal: string;
	deps: string[];
};
export type Brief = {
	goal: string;
	evidence: string;
	fences: string[];
	nodes: string[];
};
export type Item = Goal & {
	/** Cited by a candidate brief that could not start this item. */
	awaitingNodes: string[];
	parked: boolean;
	refreshAfterFix: boolean;
	verified: boolean;
	stage:
		| "planned"
		| "preparing"
		| "building"
		| "published"
		| "cleaning"
		| "merged";
	brief: Brief | null;
	worker: Worker | null;
	projectPrinciples: ProjectPrincipleFile[];
	attempt: number;
	seq: number;
	retry: number;
	mergedHead: Sha | null;
	input: "resume" | "brief" | "integration" | "rework" | "superseded";
	evidence: string;
	threads: string[];
	direction: string;
	rulings: Ruling[];
	publication: {
		sha: Sha;
		summary: string;
		addresses: string[];
		base: Sha;
	} | null;
};
export type Build = {
	phase:
		| "idle"
		| "discover"
		| "start"
		| "active"
		| "handed_off"
		| "closed"
		| "cancelled";
	mandate: Mandate | null;
	approvals: Approval[];
	revision: (RevisionProposal & { text: string }) | null;
	findings: (Omit<PlanFinding, "cause"> & {
		cause: string | null;
		items: string[];
	})[];
	queueHolds: {
		cause: string;
		items: string[];
		nodes: string[];
		evidence: string;
		forwarded: string[];
	}[];
	repo: RepoInfo | null;
	branches: { base: string; trunk: string } | null;
	base: Sha | null;
	head: Sha | null;
	seq: number;
	setupSeq: number;
	setupRetry: number;
	refreshTrunk: Sha | null;
	abandoned: Worker[];
	cleanup: {
		worker: Worker;
		mergedHead: Sha | null;
		wait: string | null;
		key: string;
	}[];
	kept: string[];
	waitingSetup: string | null;
	coordinator: {
		tool: "publish_plan" | "brief_item" | "handoff_build" | null;
		item: string | null;
		seq: number;
		finding: boolean;
		revising: boolean;
		replanning: boolean;
		pendingDirection: string;
		reason: {
			inheritedTrunk: Sha | null;
			kind: "integration" | "rework";
			evidence: string;
			threads: string[];
		} | null;
		direction: string;
	};
	items: Item[];
	holds: {
		basis: string | null;
		cause: string;
		item: string | null;
		evidence: string;
		obstruction: string;
		actual: Sha | null;
	}[];
};

export const buildDoc = defineState({
	kind: "keel.build",
	version: 1,
	scope: "conversation",
	initial: (): Build => ({
		phase: "idle",
		mandate: null,
		approvals: [],
		revision: null,
		findings: [],
		queueHolds: [],
		repo: null,
		branches: null,
		base: null,
		head: null,
		seq: 0,
		setupSeq: 0,
		setupRetry: 0,
		refreshTrunk: null,
		abandoned: [],
		cleanup: [],
		kept: [],
		waitingSetup: null,
		coordinator: {
			tool: null,
			item: null,
			seq: 0,
			finding: false,
			revising: false,
			replanning: false,
			reason: null,
			pendingDirection: "",
			direction: "",
		},
		items: [],
		holds: [],
	}),
});

export function recordApproval(
	s: Build,
	revision: number | null,
	notes: string[],
	replies: Reply[],
) {
	if (notes.length)
		s.approvals.push({
			revision,
			notes: notes.map((text, index) => ({
				...replies.find((r) => r.n === index + 1)!,
				text,
			})),
		});
}

export const unplannedFinding = (s: Build) =>
	s.findings.find((f) => f.items.length === 0);

export const repoHeld = (s: Build, id: string | null) =>
	s.holds.some((h) => h.item === id);
export const affects = (i: Item, nodes: readonly string[]) =>
	nodes.some((n) => (i.brief?.nodes ?? i.awaitingNodes).includes(n));
export const queueMatches = (h: Build["queueHolds"][number], i: Item) =>
	h.items.includes(i.id) || affects(i, h.nodes);
export const queueHeld = (s: Build, i: Item) =>
	s.queueHolds.some((h) => queueMatches(h, i));
export const held = (s: Build, id: string | null) => {
	if (repoHeld(s, id)) return true;
	if (id === null) return false;
	const item = s.items.find((i) => i.id === id);
	return !!item && queueHeld(s, item);
};
export const parked = (s: Build, i: Item) => i.parked || held(s, i.id);
export const depsReady = (s: Build, i: Item) =>
	i.deps.every((id) =>
		s.items.some((d) => d.id === id && d.stage === "merged"),
	);
export const workerKey = (i: Item) => `worker/${i.id}/${i.attempt}`;
export function newItem(goal: Goal): Item {
	return {
		...goal,
		stage: "planned",
		awaitingNodes: [],
		parked: false,
		refreshAfterFix: false,
		verified: false,
		brief: null,
		worker: null,
		projectPrinciples: [],
		attempt: 0,
		seq: 0,
		retry: 0,
		mergedHead: null,
		input: "brief",
		evidence: "",
		threads: [],
		direction: "",
		rulings: [],
		publication: null,
	};
}

export function buildView(s: Build) {
	return {
		phase: s.phase,
		plan: s.items.map(({ id, kind, goal, deps, stage, brief, verified }) => ({
			id,
			kind,
			goal,
			deps,
			stage,
			verified,
			nodes: brief?.nodes ?? [],
			brief,
		})),
		mandate: s.mandate,
		principleSamples: s.items
			.filter((i) => i.stage === "merged")
			.map((i) => ({
				worker: workerKey(i),
				kind: i.kind,
				citations: [...new Set(i.rulings.flatMap((r) => r.principles))],
			})),
		rulings: s.items.flatMap(({ id, rulings }) =>
			rulings.map((ruling) => ({ item: id, ...ruling })),
		),
		head: s.head,
		plannedFor: (cause: string) =>
			s.findings.find((f) => f.cause === cause)?.items ?? [],
		itemOf(agent: string) {
			return (
				s.items.find((i) => i.worker && workerKey(i) === agent)?.id ?? null
			);
		},
		publicationOf(agent: string) {
			const worker = s.items.find((i) => workerKey(i) === agent)?.worker;
			if (!worker || !s.repo) throw Error("No current worker checkout");
			return {
				repo: s.repo,
				worker,
				inheritedTrunk: s.coordinator.reason?.inheritedTrunk ?? null,
			};
		},
	};
}

export function validatePlan(
	s: Build,
	goals: Goal[],
	replies: Reply[],
): string | null {
	const existing = s.items;
	const firstPlan = !existing.length;
	const notes = firstPlan ? s.mandate!.approvalNotes : [];
	if (!repliesCover(notes.length, replies))
		return "Reply exactly once to each numbered approval annotation, with its disposition and a reason.";
	const first =
		existing.find((i) => i.kind === "encode") ?? existing[0] ?? goals[0];
	if (
		s.mandate!.encodeRequired &&
		(first?.kind !== "encode" ||
			goals.some((g) => g !== first && !g.deps.includes(first.id)))
	)
		return "Begin with an Encode item and make every other item depend directly on it.";
	return (
		validateGraph(existing, goals) ??
		validateDependencies(s, goals, [...existing, ...goals])
	);
}

/** Check the submitted goals, following their dependencies through the whole plan. */
export function validateDependencies(
	s: Build,
	goals: Goal[],
	plan: Goal[],
	releasing: string[] = [],
	keepFilers = false,
) {
	const byId = new Map(plan.map((g) => [g.id, g]));
	const deps = new Set(goals.flatMap((g) => g.deps));
	for (const id of deps) {
		const item = s.items.find((i) => i.id === id);
		if (
			item &&
			item.stage !== "merged" &&
			item.stage !== "cleaning" &&
			(repoHeld(s, id) ||
				s.queueHolds.some((h) =>
					releasing.includes(h.cause)
						? keepFilers && h.items.includes(id)
						: queueMatches(h, item),
				))
		)
			return `Do not depend on held item ${id}.`;
		for (const d of byId.get(id)!.deps) deps.add(d);
	}
	return null;
}

export function validateGraph(existing: Goal[], goals: Goal[]) {
	if (!goals.length) return "Name at least one item.";
	const ids = new Set(existing.map((i) => i.id));
	for (const g of goals) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(g.id) || g.id === "full" || ids.has(g.id))
			return "Use unique lowercase item IDs. The name full is reserved.";
		if (!g.goal.trim()) return "Name the goal.";
		ids.add(g.id);
	}
	if (goals.some((g) => g.deps.some((id) => !ids.has(id))))
		return "A dependency is missing from the plan.";
	const reached = new Set(existing.map((i) => i.id));
	let prev = -1;
	while (prev !== reached.size) {
		prev = reached.size;
		for (const g of goals)
			if (g.deps.every((id) => reached.has(id))) reached.add(g.id);
	}
	return reached.size === ids.size ? null : "Item dependencies form a cycle.";
}
