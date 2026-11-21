import { effectKey } from "../../kernel/ids.ts";
import {
	type Accepted,
	defineLane,
	type EffectDecl,
	type KernelEvent,
	type Lane,
	type Reduction,
	type StaticFacts,
	type World,
} from "../../kernel/lane.ts";
import { parseFences } from "../../principles/fences.ts";
import {
	layout,
	type PublishResult,
	type RepoInfo,
	type RepoResult,
	type Sha,
} from "../../repo/index.ts";
import { mandateLabels, type Reply } from "../design/public.ts";
import { fileHolding, type Resume, resumption } from "../queue/public.ts";
import type { Publication } from "../verify/public.ts";
import { agents, ownerDirection, renderReport } from "./agents.ts";
import { cancel, cleanupEffects, settleCleanup } from "./cancel.ts";
import type { BuildUpdate, Ruling } from "./public.ts";
import {
	type Brief,
	type Build,
	buildDoc,
	buildView,
	type Goal,
	held,
	type Item,
	validatePlan,
	workerKey,
} from "./state.ts";
import { buildV1 } from "./v1.ts";

export { buildTools } from "./tools.ts";

type Event =
	| BuildUpdate
	| Resume
	| { kind: "plan"; items: Goal[]; replies?: Reply[] }
	| ({ kind: "brief"; item: string; fences: string } & Omit<Brief, "fences">)
	| { kind: "handoff"; summary: string; risk: string }
	| { kind: "ruling"; agent: string; ruling: Ruling }
	| {
			kind: "publish";
			agent: string;
			summary: string;
			addresses: string[];
			facts: PublishResult;
	  }
	| { kind: "cancel" };

function coordinator(
	s: Build,
	tool: Build["coordinator"]["tool"],
	item: string | null = null,
) {
	const c = s.coordinator;
	c.direction = tool ? c.pendingDirection : "";
	if (tool) c.pendingDirection = "";
	Object.assign(c, { tool, item, seq: ++s.seq });
}
function schedule(s: Build, w: World) {
	if (s.coordinator.tool || held(s, null) || s.phase !== "active") return;
	if (s.items.every((i) => i.stage === "merged")) {
		coordinator(s, "handoff_build");
		return;
	}
	const busy = s.items.filter(
		(i) => i.stage !== "planned" && i.stage !== "merged",
	).length;
	if (busy >= w.options.max_workers) return;
	const next = s.items.find(
		(i) =>
			i.stage === "planned" &&
			i.deps.every((id) =>
				s.items.some((d) => d.id === id && d.stage === "merged"),
			),
	);
	if (next) coordinator(s, "brief_item", next.id);
}
function discover(s: Build, w: World) {
	s.phase = "discover";
	s.setupSeq = ++s.seq;
	s.setupRetry = 0;
	s.branches = { base: w.options.base, trunk: w.options.trunk };
}
function prepare(s: Build, i: Item, w: World) {
	const work = String(w.work);
	if (i.worker) s.abandoned.push(i.worker);
	const attempt = ++i.attempt;
	i.stage = "preparing";
	i.projectPrinciples = [];
	i.retry = 0;
	i.worker = {
		kind: "worktree",
		key: `worker:${work}:${i.id}:${attempt}`,
		path: layout.worktree(s.repo!, work, `worker-${i.id}-${attempt}`),
		branch: layout.itemBranch(work, i.id, attempt),
		from: layout.buildBranch(work),
		base: s.head!,
	};
}
function disposeReplacedAttempts(s: Build, item: Item, w: World) {
	const prefix = `worker:${w.work}:${item.id}:`;
	s.abandoned = s.abandoned.filter((worker) => {
		if (!worker.key.startsWith(prefix)) return true;
		s.cleanup.push({
			worker,
			mergedHead: null,
			wait: null,
			key: `replace/remove/${worker.key}`,
		});
		return false;
	});
}
// An owner retry gets a new kernel delivery. The git plan still has its original key:
// a CAS or branch creation may already have succeeded before the runner lost its reply.
const delivery = (plan: string, retry: number) =>
	effectKey(retry ? `${plan}/retry/${retry}` : plan);
function plans(
	s: Build,
	w: StaticFacts,
): { item: string | null; effect: EffectDecl }[] {
	const work = String(w.work);
	if ((s.phase === "discover" || s.phase === "start") && !held(s, null)) {
		const key = `${s.refreshTrunk ? "refresh" : s.phase}:${work}:${s.setupSeq}`;
		const effect: EffectDecl =
			s.phase === "discover" || s.refreshTrunk
				? {
						key: delivery(key, s.setupRetry),
						spec: { kind: "read_repo", ...s.branches },
					}
				: {
						key: delivery(key, s.setupRetry),
						spec: {
							repo: s.repo!,
							op: {
								kind: "start_build",
								key,
								branch: layout.buildBranch(work),
							},
						},
					};
		return [{ item: null, effect }];
	}
	if (s.phase !== "active") return [];
	return s.items.flatMap((i) => {
		if ((i.stage !== "preparing" && i.stage !== "cleaning") || held(s, i.id))
			return [];
		const worker = i.worker!;
		const op =
			i.stage === "preparing"
				? worker
				: {
						kind: "remove",
						key: `remove:${worker.key}`,
						merged: true,
						mergedHead: i.mergedHead!,
						target: worker,
					};
		return [
			{
				item: i.id,
				effect: { key: delivery(op.key, i.retry), spec: { repo: s.repo!, op } },
			},
		];
	});
}
function ourAdvance(s: Build, i: Item, actual: Sha | null) {
	return actual !== null && actual === s.head && i.worker!.base !== actual;
}
function holdingMessage(s: Build, w: World, h: Build["holds"][number]) {
	const { item, obstruction, cause, evidence } = h;
	const stage = s.items.find((i) => i.id === item)?.stage;
	const resume =
		s.phase === "discover"
			? resumption.discovery
			: stage === "preparing" && obstruction === "moved"
				? resumption.moved
				: stage === "preparing" && obstruction === "occupied"
					? resumption.occupied
					: s.phase === "start" || stage === "preparing" || stage === "cleaning"
						? resumption
								.pinned({
									operation:
										s.phase === "start"
											? "start_build"
											: stage === "preparing"
												? "worktree"
												: "remove",
								})
								.trim()
						: item
							? resumption.worker
							: resumption.coordinator;
	return fileHolding({
		work: w.work!,
		lane: "build",
		goal: s.mandate!.intent,
		resume,
		item,
		cause,
		evidence,
	});
}
function hold(
	s: Build,
	w: World,
	item: string | null,
	obstruction: string,
	evidence: string,
	actual: Sha | null = null,
): Accepted<Build> {
	const h = { cause: `build/${++s.seq}`, item, obstruction, evidence, actual };
	s.holds.push(h);
	return obstruction === "unattributed"
		? { state: s }
		: { state: s, send: [holdingMessage(s, w, h)] };
}
/** A merge can have written Git before Verify records its result. */
function settleMovedPreparations(s: Build, w: World) {
	return s.holds.flatMap((h) => {
		if (h.obstruction !== "unattributed") return [];
		const i = s.items.find((i) => i.id === h.item)!;
		if (ourAdvance(s, i, h.actual)) {
			s.holds = s.holds.filter((other) => other !== h);
			prepare(s, i, w);
			return [];
		}
		if (s.items.some((i) => i.stage === "published")) return [];
		h.obstruction = "moved";
		return [holdingMessage(s, w, h)];
	});
}
function onFact(s: Build, e: KernelEvent, w: World): Accepted<Build> {
	const state = s;
	if (s.phase === "cancelled") return settleCleanup(s, e, w);
	if (s.phase === "closed") return { state };
	switch (e.kind) {
		case "effect_done":
		case "effect_failed": {
			if (s.cleanup.some((j) => j.key === e.key)) return settleCleanup(s, e, w);
			const planned = plans(s, w).find((p) => p.effect.key === e.key);
			if (!planned) return { state };
			const id = planned.item;
			if (e.kind === "effect_failed")
				return hold(s, w, id, "failed", `${e.key}: ${e.error}`);
			const result = e.result as RepoResult | { kind: "repo"; repo: RepoInfo };
			if (
				s.phase === "start" &&
				result.kind === "moved" &&
				result.keelMoved &&
				result.actual
			) {
				s.refreshTrunk = result.actual;
				s.setupRetry++;
				return { state };
			}
			if (s.phase === "start" && s.refreshTrunk && result.kind === "repo") {
				// Only the move repo attributed may replace our immutable start plan.
				if (result.repo.trunkHead === s.refreshTrunk) {
					s.repo = result.repo;
					s.setupSeq = ++s.seq;
					s.setupRetry = 0;
				}
				s.refreshTrunk = null;
				return { state };
			}
			const i = s.items.find((i) => i.id === id);
			if (
				i?.stage === "preparing" &&
				result.kind === "moved" &&
				ourAdvance(s, i, result.actual)
			) {
				prepare(s, i, w);
				break;
			}
			if (result.kind === "moved" || result.kind === "occupied")
				return hold(
					s,
					w,
					id,
					result.kind === "moved" &&
						result.actual !== null &&
						i?.stage === "preparing" &&
						s.items.some((other) => other.stage === "published")
						? "unattributed"
						: result.kind,
					`${e.key}: ${JSON.stringify(result)}`,
					result.kind === "moved" ? result.actual : null,
				);
			if (id === null && s.phase === "discover" && result.kind === "repo") {
				s.repo = result.repo;
				s.phase = "start";
				s.setupSeq = ++s.seq;
				s.setupRetry = 0;
				return { state };
			}
			if (id === null && s.phase === "start" && result.kind === "started") {
				s.base = s.head = result.base;
				s.phase = "active";
				coordinator(s, "publish_plan");
				return { state };
			}
			if (i?.stage === "preparing" && result.kind === "worktree") {
				disposeReplacedAttempts(s, i, w);
				i.projectPrinciples = [...result.principles];
				i.stage = "building";
				i.seq = ++s.seq;
				break;
			}
			if (
				i?.stage === "cleaning" &&
				(result.kind === "removed" || result.kind === "kept")
			) {
				i.stage = "merged";
				if (result.kind === "removed") i.worker = null;
				schedule(s, w);
				return {
					state,
					notes:
						result.kind === "kept"
							? [
									{
										agent: null,
										text: `Kept ${i.worker!.path}: ${result.reason}: ${result.files.join(", ")}`,
									},
								]
							: [],
				};
			}
			throw Error(`Unexpected Build result ${result.kind} for ${e.key}`);
		}
		case "agent_stalled": {
			const agent = agents(s).find(
				(a) =>
					a.key === e.agent &&
					a.expects.some((x) => e.tokens.includes(x.token)),
			);
			if (!agent) return { state };
			const id =
				agent.role === "coordinator"
					? null
					: s.items.find((i) => workerKey(i) === agent.key)!.id;
			return hold(s, w, id, "stall", `${agent.key} ${e.cause}: ${e.lastWords}`);
		}

		case "answered":
			return { state };
	}
	schedule(s, w);
	return { state };
}
function reduce(s: Build, e: Event, w: World): Reduction<Build> {
	const state = s;
	if (s.phase === "cancelled" || s.phase === "closed") return { state };
	if (e.kind === "cancel") return cancel(s, w, plans(s, w));
	if (e.kind === "closed") {
		s.phase = "closed";
		return { state };
	}
	function verify(event: Publication): Reduction<Build> {
		return { state, send: [{ lane: "verify", work: w.work, event }] };
	}
	function publish(i: Item, changedPolicyFiles: string[]) {
		const p = i.publication!;
		i.stage = "published";
		i.direction = "";
		return verify({
			kind: "published",
			item: i.id,
			paths: i.brief!.fences,
			sha: p.sha,
			base: p.base,
			changedPolicyFiles,
			addresses: p.addresses,
			repo: s.repo!,
			head: s.head!,
			mandate: s.mandate!,
			brief: renderReport(s, i, p.summary),
			rulings: i.rulings,
		});
	}
	switch (e.kind) {
		case "bound":
			if (s.phase !== "idle")
				return { reject: "The Mandate is already bound." };
			s.mandate = e.mandate;
			discover(s, w);
			return { state };
		case "plan": {
			if (s.coordinator.tool !== "publish_plan" || held(s, null))
				return { reject: "No plan is due." };
			const replies = e.replies ?? [];
			const reject = validatePlan(s, e.items, replies);
			if (reject) return { reject };
			if (!s.items.length) s.approvalReplies = replies;
			for (const goal of e.items)
				s.items.push({
					...goal,
					stage: "planned",
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
				});
			coordinator(s, null);
			break;
		}
		case "brief": {
			const i = s.items.find((i) => i.id === e.item);
			if (
				held(s, null) ||
				s.coordinator.tool !== "brief_item" ||
				s.coordinator.item !== e.item ||
				i?.stage !== "planned"
			)
				return { reject: "Brief only the requested ready item." };
			if (
				!e.nodes.length ||
				e.nodes.some((n) => !mandateLabels(s.mandate!).includes(n))
			)
				return { reject: "Cite labels from the bound Mandate." };
			if (![e.goal, e.evidence].every((v) => v.trim()))
				return { reject: "State the goal and evidence." };
			const fences = parseFences(e.fences);
			if ("reject" in fences) return fences;
			i.brief = {
				goal: e.goal,
				evidence: e.evidence,
				fences: fences.paths,
				nodes: e.nodes,
			};
			prepare(s, i, w);
			coordinator(s, null);
			break;
		}
		case "ruling":
		case "publish": {
			const i = s.items.find((i) => workerKey(i) === e.agent);
			if (i?.stage !== "building" || held(s, i.id))
				return { reject: "No active worker item." };
			if (e.kind === "ruling") {
				i.rulings.push(e.ruling);
				return { state };
			}
			const f = e.facts;
			if (f.kind === "dirty")
				return {
					reject: `Commit or clean these paths before publishing: ${f.files.join(", ")}`,
				};
			if (f.kind === "not_descendant")
				return {
					reject: "The worker commit must descend from its pinned base.",
				};
			if (f.kind === "occupied" || f.kind === "moved")
				return hold(s, w, i.id, f.kind, JSON.stringify(f));
			if (
				new Set(e.addresses).size !== e.addresses.length ||
				e.addresses.some(
					(id) =>
						!i.threads.includes(id) &&
						!s.coordinator.reason?.threads.includes(id),
				)
			)
				return {
					reject: "Name only distinct thread IDs returned to this worker.",
				};
			i.publication = {
				sha: f.sha,
				base: f.base,
				summary: e.summary,
				addresses: e.addresses,
			};
			return publish(i, [...f.changedPolicyFiles]);
		}
		case "integration":
		case "rework": {
			if (e.item === "full" && s.phase === "handed_off") {
				s.phase = "active";
				s.head = e.head ?? s.head;
				s.coordinator.pendingDirection = e.direction ?? "";
				s.coordinator.reason = {
					inheritedTrunk: e.inheritedTrunk ?? null,
					kind: e.kind,
					evidence: e.evidence,
					threads: e.threads,
				};
				coordinator(s, "publish_plan");
				return { state };
			}
			const i = s.items.find((i) => i.id === e.item);
			if (i?.stage !== "published")
				return { reject: "Only a published item can be returned." };
			i.direction = e.direction ?? "";
			i.input = e.kind;
			i.stage = "building";
			i.evidence = e.evidence;
			i.threads = e.threads;
			i.seq = ++s.seq;
			return { state, send: settleMovedPreparations(s, w) };
		}
		case "merged": {
			const i = s.items.find((i) => i.id === e.item);
			if (i?.stage !== "published")
				return { reject: "Only a published item can be merged." };
			s.head = i.mergedHead = e.head;
			i.stage = "cleaning";
			i.retry = 0;
			const send = settleMovedPreparations(s, w);
			schedule(s, w);
			return { state, send };
		}
		case "handoff":
			if (
				s.phase !== "active" ||
				s.coordinator.tool !== "handoff_build" ||
				held(s, null)
			)
				return { reject: "Handoff waits for all items to merge." };
			coordinator(s, null);
			s.phase = "handed_off";
			return verify({
				kind: "handoff",
				repo: s.repo!,
				base: s.base!,
				head: s.head!,
				mandate: s.mandate!,
				rulings: s.items.flatMap((i) => i.rulings),
				approvalReplies: s.approvalReplies,
				summary: e.summary,
				risk: e.risk,
			});
		case "resume": {
			const h = s.holds.find((h) => h.cause === e.cause && h.item === e.item);
			if (!h) return { state };
			const i = s.items.find((item) => item.id === e.item);
			s.holds = s.holds.filter((other) => other !== h);
			const direction = ownerDirection({
				direction: e.direction,
				evidence: h.evidence,
			});
			if (i?.stage === "building") {
				i.input = "resume";
				i.direction = direction;
			} else if (i?.stage === "preparing") {
				i.direction = [i.direction, direction].filter(Boolean).join("\n");
			} else if (!i && s.coordinator.tool) {
				s.coordinator.direction = direction;
			} else {
				// Setup and cleanup have no live worker. Deliver on the next new coordinator turn.
				const c = s.coordinator;
				c.pendingDirection = [c.pendingDirection, direction]
					.filter(Boolean)
					.join("\n");
			}
			if (!i) {
				s.coordinator.seq = ++s.seq;
				if (s.phase === "discover") discover(s, w);
				else if (s.phase === "start") s.setupRetry++;
			} else if (!held(s, i.id)) {
				if (
					i.stage === "preparing" &&
					(h.obstruction === "occupied" ||
						(h.obstruction === "moved" && ourAdvance(s, i, h.actual)))
				)
					prepare(s, i, w);
				else if (i.stage === "preparing" || i.stage === "cleaning") i.retry++;
				else i.seq = ++s.seq;
			}
			break;
		}
		default:
			return { state };
	}
	schedule(s, w);
	return { state };
}
const build: Lane<Build> = {
	name: "build",
	state: buildDoc,
	reduce: (s, e, w) => reduce(structuredClone(s), e as Event, w),
	onFact: (s, e, w) => onFact(structuredClone(s), e, w),
	agents,
	view: buildView,
	asks: () => [],
	effects: (s, w) =>
		s.phase === "cancelled"
			? cleanupEffects(s)
			: [...plans(s, w).map((p) => p.effect), ...cleanupEffects(s)],
};
export const buildLane = defineLane(build, buildV1);
