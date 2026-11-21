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
	recordApproval,
	validateDependencies,
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
	keepFilers = false,
): Message[] {
	const h = s.queueHolds.find((h) => h.cause === cause);
	if (!h) return [];
	const guidance = ownerDirection({
		direction: direction ?? "",
		evidence: h.evidence,
	});
	const kept = keepFilers ? h.items : [];
	for (const i of s.items) {
		if (
			kept.includes(i.id) ||
			!queueMatches(h, i) ||
			i.stage === "cleaning" ||
			i.stage === "merged"
		)
			continue;
		addDirection(i, guidance);
		if (i.input === "brief" && i.stage === "building") i.input = "resume";
	}
	const releaseForwarded = h.forwarded.some((id) => !kept.includes(id));
	if (kept.length) {
		h.nodes = [];
		h.forwarded = h.forwarded.filter((id) => kept.includes(id));
	} else s.queueHolds = s.queueHolds.filter((hold) => hold !== h);
	return releaseForwarded
		? [
				{
					lane: "verify",
					work: w.work,
					event: {
						kind: "queue_release",
						cause,
						...(kept.length && { except: kept }),
						...(direction === undefined ? {} : { direction }),
					},
				},
			]
		: [];
}

export const record = (i: Item) =>
	i.verified || i.stage === "cleaning" || i.stage === "merged";

function replacementPlan(
	s: Build,
	p: RevisionProposal | null,
	goals: Goal[],
	replies: Reply[],
) {
	if (!repliesCover(p?.mandate.approvalNotes.length ?? 0, replies))
		return "Reply exactly once to each numbered approval annotation, with its disposition and a reason.";
	const byId = new Map(goals.map((g) => [g.id, g]));
	const old = new Map(s.items.map((i) => [i.id, i]));
	const newGoals = goals.filter((g) => !old.has(g.id));
	const releasing = p ? [...p.causes, revisionPlanHold] : [];
	const addedDeps = goals.map((g) => ({
		...g,
		deps: g.deps.filter((d) => !old.get(g.id)?.deps.includes(d)),
	}));
	const graph =
		validateGraph([], goals) ??
		validateDependencies(s, goals, goals, releasing) ??
		(p && newGoals.length
			? validateDependencies(s, addedDeps, goals, releasing, true)
			: null);
	if (graph) return graph;
	const labels = new Set(mandateLabels(p?.mandate ?? s.mandate!));
	for (const i of s.items) {
		const removed = i.brief?.nodes.find((n) => !labels.has(n));
		if (removed)
			return `Item ${i.id} cites ${removed}, a removed Mandate node.`;
		if (i.stage === "planned") continue;
		const g = byId.get(i.id);
		if (!g || g.kind !== i.kind || g.goal !== i.goal)
			return `Keep the started item ${i.id} unchanged. Edit only unstarted goals.`;
		const affected = !p || affects(i, p.nodes);
		const depsChanged =
			g.deps.length !== i.deps.length ||
			g.deps.some((id, n) => id !== i.deps[n]);
		const filer = s.queueHolds.some(
			(h) => p?.causes.includes(h.cause) && h.items.includes(i.id),
		);
		if (depsChanged && (record(i) || (!affected && !filer) || !queueHeld(s, i)))
			return `Keep the dependencies of ${i.id}. Only a held filer or a held, affected item can change dependencies before verification.`;
		if (
			p &&
			affected &&
			record(i) &&
			!newGoals.some((g) => g.deps.includes(i.id))
		)
			return `Add a new correction that depends on verified item ${i.id}; keep its record intact.`;
	}
	for (const f of s.findings) {
		const missing = f.items.find((id) => !byId.has(id));
		if (missing) return `Keep item ${missing} planned for ${f.cause}.`;
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

export function replan(s: Build, goals: Goal[], replies: Reply[]) {
	const reject = replacementPlan(s, null, goals, replies);
	if (reject) return reject;
	const old = new Map(s.items.map((i) => [i.id, i]));
	s.items = goals.map((g) => ({ ...(old.get(g.id) ?? newItem(g)), ...g }));
	return null;
}

export function waitingPicture(s: Build, waiting: string) {
	const headline = (evidence: string) =>
		evidence
			.split("\n")
			.find((line) => line.startsWith("### Finding #"))
			?.slice(4) ?? evidence.split("\n", 1)[0];
	return [
		waiting,
		...s.items
			.filter((i) => i.stage !== "merged")
			.map((i) => {
				const waits = s.queueHolds
					.filter((h) => queueMatches(h, i))
					.map((h) => {
						const planned = s.findings.find((f) => f.cause === h.cause);
						return `${headline(planned?.text || h.evidence || s.revision?.text || h.cause)}${planned?.items.length ? ` (waiting for ${planned.items.join(", ")} to merge)` : ""}`;
					});
				waits.push(
					...s.holds
						.filter((h) => h.item === i.id)
						.map((h) => headline(h.evidence) || h.cause),
				);
				return `- ${i.id} (${i.stage}): ${waits.length ? `held by ${waits.join("; ")}` : "no hold"}; depends on ${i.deps.join(", ") || "nothing"}.`;
			}),
	].join("\n");
}

export function applyRevision(
	s: Build,
	goals: Goal[],
	replies: Reply[],
	w: World,
): Reduction<Build> {
	const p = s.revision!;
	const reject = replacementPlan(s, p, goals, replies);
	if (reject) return { reject };
	const old = new Map(s.items.map((i) => [i.id, i]));
	const evidence = p.text || `Changed Mandate nodes: ${p.nodes.join(", ")}`;
	const superseded: string[] = [];
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
			if (i.input === "brief" && i.stage === "building") i.input = "resume";
			// Revised dependencies gate this attempt.
			i.parked = true;
		}
		return { ...i, deps: g.deps };
	});
	s.mandate = p.mandate;
	recordApproval(s, p.number, p.mandate.approvalNotes, replies);
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
	const newItems = goals.filter((g) => !old.has(g.id)).map((g) => g.id);
	for (const cause of [...p.causes, revisionPlanHold]) {
		const hold = s.queueHolds.find((h) => h.cause === cause);
		const fixing = !!hold?.items.length && newItems.length > 0;
		if (fixing)
			s.findings.push({
				kind: "plan_finding",
				cause,
				text: hold.evidence,
				reference: "Mandate revision",
				nodes: p.nodes,
				items: newItems,
			});
		send.push(...releaseQueueHold(s, cause, undefined, w, fixing));
	}
	send.push({
		lane: "design",
		work: w.work,
		event: { kind: "revision_activated", causes: p.causes },
	});
	return { state: s, send };
}
