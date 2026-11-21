import {
	type Message,
	prose,
	type Reduction,
	type World,
} from "../../kernel/lane.ts";
import { mandateLabels, type Reply, repliesCover } from "../design/public.ts";
import { ownerDirection } from "./agents.ts";
import type { BuildUpdate, RevisionProposal } from "./public.ts";
import {
	affects,
	type Build,
	type Goal,
	type Item,
	newItem,
	queueHeld,
	queueMatches,
	validateGraph,
} from "./state.ts";

const revisionDirection = prose(
	import.meta.dirname,
	"../../prose/documents/build-revised-item.md",
	["nodes", "evidence", "deps", "branch"],
);

export const revisionPlanHold = "revision/plan";

export function addDirection(i: Item, direction: string) {
	i.direction = [i.direction, direction].filter(Boolean).join("\n");
}

export function addQueueHold(
	s: Build,
	e: Extract<BuildUpdate, { kind: "queue_hold" }>,
	w: World,
): Message[] {
	if (e.item === null && !e.nodes.length) return [];
	let h = s.queueHolds.find((h) => h.cause === e.cause);
	if (!h) {
		h = {
			cause: e.cause,
			items: [],
			nodes: [],
			evidence: "",
			forwarded: [],
			fix: null,
		};
		s.queueHolds.push(h);
	}
	if (e.item !== null && !h.items.includes(e.item)) h.items.push(e.item);
	h.nodes = [...new Set([...h.nodes, ...e.nodes])];
	if (e.evidence) h.evidence = e.evidence;
	const send: Message[] = [];
	for (const i of s.items) {
		if (
			!queueMatches(h, i) ||
			i.stage === "planned" ||
			i.stage === "cleaning" ||
			i.stage === "merged"
		)
			continue;
		i.parked = true;
		if (i.stage !== "published" || h.forwarded.includes(i.id)) continue;
		h.forwarded.push(i.id);
		send.push({
			lane: "verify",
			work: w.work,
			event: {
				kind: "queue_hold",
				item: i.id,
				cause: e.cause,
				evidence: h.evidence,
			},
		});
	}
	return send;
}

export function releaseQueueHold(
	s: Build,
	cause: string,
	direction: string | undefined,
	w: World,
): Message[] {
	const h = s.queueHolds.find((h) => h.cause === cause);
	if (!h) return [];
	const guidance = ownerDirection({
		direction: direction ?? "",
		evidence: h.evidence,
	});
	for (const i of s.items) {
		if (!queueMatches(h, i) || i.stage === "cleaning" || i.stage === "merged")
			continue;
		addDirection(i, guidance);
		if (i.input === "brief" && i.stage === "building") i.input = "resume";
	}
	s.queueHolds = s.queueHolds.filter((hold) => hold !== h);
	return h.forwarded.length
		? [
				{
					lane: "verify",
					work: w.work,
					event: {
						kind: "queue_release",
						cause,
						...(direction === undefined ? {} : { direction }),
					},
				},
			]
		: [];
}

export type FindingFix = { cause: string; item: string };
export function bindFixes(s: Build, goals: Goal[], fixes: FindingFix[]) {
	const due = s.findings
		.slice(0, s.coordinator.findings)
		.flatMap((f) =>
			s.queueHolds.filter((h) => h.cause === f.cause && h.fix === null),
		);
	const byId = new Map([...s.items, ...goals].map((g) => [g.id, g]));
	if (
		new Set(fixes.map((f) => f.cause)).size !== due.length ||
		fixes.length !== due.length
	)
		return "Name one new item to fix each held defect using fixes.";
	for (const h of due) {
		const id = fixes.find((f) => f.cause === h.cause)?.item;
		if (!id || !goals.some((g) => g.id === id))
			return `Name a new fix item for ${h.cause}.`;
		const blocked = new Set(h.items);
		const dependsOnBlocked = (id: string): boolean =>
			blocked.has(id) || (byId.get(id)?.deps ?? []).some(dependsOnBlocked);
		if (dependsOnBlocked(id))
			return `Fix ${h.cause} without depending on its blocked item.`;
		h.fix = id;
	}
	return null;
}

export const record = (i: Item) =>
	i.verified || i.stage === "cleaning" || i.stage === "merged";

function revisionPlan(
	s: Build,
	p: RevisionProposal,
	goals: Goal[],
	replies: Reply[],
) {
	if (!repliesCover(p.mandate.approvalNotes.length, replies))
		return "Reply exactly once to each numbered approval annotation, with its disposition and a reason.";
	const graph = validateGraph([], goals);
	if (graph) return graph;
	const byId = new Map(goals.map((g) => [g.id, g]));
	const oldIds = new Set(s.items.map((i) => i.id));
	const newGoals = goals.filter((g) => !oldIds.has(g.id));
	for (const i of s.items) {
		if (i.stage === "planned") continue;
		const g = byId.get(i.id);
		if (!g || g.kind !== i.kind || g.goal !== i.goal)
			return `Keep the started item ${i.id} unchanged. Edit only unstarted goals.`;
		const affected = affects(i, p.nodes);
		const depsChanged =
			g.deps.length !== i.deps.length ||
			g.deps.some((id, n) => id !== i.deps[n]);
		if (depsChanged && (record(i) || !affected || !queueHeld(s, i)))
			return `Keep the dependencies of ${i.id}. Only a held, affected item that has not been verified can change dependencies.`;
		if (affected && record(i) && !newGoals.some((g) => g.deps.includes(i.id)))
			return `Add a new correction that depends on verified item ${i.id}; keep its record intact.`;
	}
	for (const h of s.queueHolds) {
		if (h.fix && !byId.has(h.fix))
			return `Keep item ${h.fix} until it fixes ${h.cause}.`;
	}
	const encode =
		s.items.find((i) => i.kind === "encode" && i.stage !== "planned") ??
		goals[0];
	if (
		s.mandate!.encodeRequired &&
		(encode?.kind !== "encode" ||
			goals.some((g) => g.id !== encode.id && !g.deps.includes(encode.id)))
	)
		return "Keep the initial Encode item and its direct dependencies.";
	return null;
}

export function applyRevision(
	s: Build,
	goals: Goal[],
	replies: Reply[],
	w: World,
): Reduction<Build> {
	const p = s.revision!;
	const reject = revisionPlan(s, p, goals, replies);
	if (reject) return { reject };
	const old = new Map(s.items.map((i) => [i.id, i]));
	const evidence = p.text || `Changed Mandate nodes: ${p.nodes.join(", ")}`;
	const superseded: string[] = [];
	const retained = new Set(mandateLabels(p.mandate));
	s.items = goals.map((g) => {
		const i = old.get(g.id);
		if (!i) return newItem(g);
		if (i.stage === "planned") return { ...newItem(g), direction: i.direction };
		if (!record(i) && affects(i, p.nodes)) {
			addDirection(
				i,
				revisionDirection({
					nodes: p.nodes.join(", "),
					evidence,
					deps: g.deps.join(", ") || "None",
					branch: i.worker?.from ?? "the build branch",
				}),
			);
			if (i.stage === "published") superseded.push(i.id);
			if (i.brief) i.brief.nodes = i.brief.nodes.filter((n) => retained.has(n));
			i.awaitingNodes = i.awaitingNodes.filter((n) => retained.has(n));
			if (i.input === "brief" && i.stage === "building") i.input = "resume";
			// Revised dependencies gate this attempt.
			i.parked = true;
		}
		return { ...i, deps: g.deps };
	});
	const originalNotes = s.mandate!.approvalNotes;
	s.mandate = {
		...p.mandate,
		approvalNotes: [...originalNotes, ...p.mandate.approvalNotes],
	};
	s.approvalReplies.push(
		...replies.map((reply) => ({
			...reply,
			n: originalNotes.length + reply.n,
		})),
	);
	s.revision = null;
	const send: Message[] = [
		{
			lane: "verify",
			work: w.work,
			event: {
				kind: "mandate_revised",
				mandate: p.mandate,
				items: superseded,
				evidence,
			},
		},
	];
	for (const cause of [...p.causes, revisionPlanHold])
		send.push(...releaseQueueHold(s, cause, undefined, w));
	send.push({
		lane: "design",
		work: w.work,
		event: { kind: "revision_activated", causes: p.causes },
	});
	return { state: s, send };
}
