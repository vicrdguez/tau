import { defineState } from "../../kernel/state.ts";
import type { RepoInfo, Sha, Worker } from "../../repo/index.ts";
import type { Mandate } from "../design/public.ts";
import type { Ruling } from "./public.ts";

export type Goal = {
	id: string;
	kind: "build" | "encode";
	goal: string;
	deps: string[];
};
export type Brief = {
	goal: string;
	evidence: string;
	fences: string;
	nodes: string[];
};
export type Item = Goal & {
	stage:
		| "planned"
		| "preparing"
		| "building"
		| "published"
		| "cleaning"
		| "merged";
	brief: Brief | null;
	worker: Worker | null;
	attempt: number;
	seq: number;
	retry: number;
	mergedHead: Sha | null;
	input: "brief" | "integration" | "rework";
	evidence: string;
	threads: string[];
	direction: string;
	rulings: Ruling[];
	publication: { sha: Sha; summary: string; addresses: string[] } | null;
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
	repo: RepoInfo | null;
	branches: { base: string; trunk: string } | null;
	base: Sha | null;
	head: Sha | null;
	seq: number;
	setupSeq: number;
	setupRetry: number;
	coordinator: {
		tool: "publish_plan" | "brief_item" | "handoff_build" | null;
		item: string | null;
		seq: number;
		reason: {
			kind: "integration" | "rework";
			evidence: string;
			threads: string[];
		} | null;
		direction: string;
	};
	items: Item[];
	holds: {
		cause: string;
		item: string | null;
		evidence: string;
		obstruction: string;
	}[];
};

export const buildDoc = defineState({
	kind: "keel.build",
	version: 1,
	scope: "conversation",
	initial: (): Build => ({
		phase: "idle",
		mandate: null,
		repo: null,
		branches: null,
		base: null,
		head: null,
		seq: 0,
		setupSeq: 0,
		setupRetry: 0,
		coordinator: {
			tool: null,
			item: null,
			seq: 0,
			reason: null,
			direction: "",
		},
		items: [],
		holds: [],
	}),
});

export const held = (s: Build, id: string | null) =>
	s.holds.some((h) => h.item === id);
export const workerKey = (i: Item) => `worker/${i.id}/${i.attempt}`;

export function buildView(s: Build) {
	return {
		publicationOf(agent: string) {
			const worker = s.items.find((i) => workerKey(i) === agent)?.worker;
			if (!worker || !s.repo || !s.mandate)
				throw Error("No current worker checkout");
			return { repo: s.repo, worker, protectedPaths: s.mandate.protectedPaths };
		},
	};
}

export function validatePlan(existing: Item[], goals: Goal[]): string | null {
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
