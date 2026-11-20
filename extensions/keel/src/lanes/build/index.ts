import { effectKey } from "../../kernel/ids.ts";
import {
	defineLane,
	type EffectDecl,
	type KernelEvent,
	type Lane,
	type Reduction,
	type StaticFacts,
	type World,
} from "../../kernel/lane.ts";
import {
	layout,
	type PublishResult,
	type RepoInfo,
	type RepoResult,
} from "../../repo/index.ts";
import { mandateLabels } from "../design/public.ts";
import { fileHolding, type Resume } from "../queue/public.ts";
import type { Publication } from "../verify/public.ts";
import { agents, ownerDirection, renderReport } from "./agents.ts";
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
	| KernelEvent
	| BuildUpdate
	| Resume
	| { kind: "plan"; items: Goal[] }
	| ({ kind: "brief"; item: string } & Brief)
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
	Object.assign(s.coordinator, { tool, item, seq: ++s.seq });
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
function prepare(s: Build, i: Item, w: World) {
	const work = String(w.work);
	const attempt = ++i.attempt;
	i.stage = "preparing";
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
		const key = `${s.phase}:${work}:${s.setupSeq}`;
		const effect: EffectDecl =
			s.phase === "discover"
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
function reduce(s: Build, e: Event, w: World): Reduction<Build> {
	const state = s;
	if (s.phase === "cancelled" || s.phase === "closed") return { state };
	if (e.kind === "cancel") {
		s.phase = "cancelled";
		return { state };
	}
	if (e.kind === "closed") {
		s.phase = "closed";
		return { state };
	}
	function hold(
		item: string | null,
		obstruction: string,
		evidence: string,
	): Reduction<Build> {
		const cause = `build/${++s.seq}`;
		s.holds.push({ cause, item, obstruction, evidence });
		return {
			state,
			send: [
				fileHolding({ work: w.work!, lane: "build", item, cause, evidence }),
			],
		};
	}
	function verify(event: Publication): Reduction<Build> {
		return { state, send: [{ lane: "verify", work: w.work, event }] };
	}
	switch (e.kind) {
		case "bound":
			if (s.phase !== "idle")
				return { reject: "The Mandate is already bound." };
			s.mandate = e.mandate;
			s.phase = "discover";
			s.setupSeq = ++s.seq;
			s.branches = { base: w.options.base, trunk: w.options.trunk };
			return { state };
		case "plan": {
			if (s.coordinator.tool !== "publish_plan" || held(s, null))
				return { reject: "No plan is due." };
			const reject = validatePlan(s.items, e.items);
			if (reject) return { reject };
			for (const goal of e.items)
				s.items.push({
					...goal,
					stage: "planned",
					brief: null,
					worker: null,
					attempt: 0,
					seq: 0,
					retry: 0,
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
			if (![e.goal, e.evidence, e.fences].every((v) => v.trim()))
				return { reject: "State the goal, evidence and fences." };
			i.brief = {
				goal: e.goal,
				evidence: e.evidence,
				fences: e.fences,
				nodes: e.nodes,
			};
			prepare(s, i, w);
			coordinator(s, null);
			break;
		}
		case "effect_done":
		case "effect_failed": {
			const planned = plans(s, w).find((p) => p.effect.key === e.key);
			if (!planned) return { state };
			const id = planned.item;
			if (e.kind === "effect_failed")
				return hold(id, "failed", `${e.key}: ${e.error}`);
			const result = e.result as RepoResult | { kind: "repo"; repo: RepoInfo };
			if (result.kind === "moved" || result.kind === "occupied")
				return hold(id, result.kind, `${e.key}: ${JSON.stringify(result)}`);
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
			const i = s.items.find((i) => i.id === id);
			if (i?.stage === "preparing" && result.kind === "worktree") {
				i.stage = "building";
				i.seq = ++s.seq;
				break;
			}
			if (
				i?.stage === "cleaning" &&
				(result.kind === "removed" || result.kind === "kept")
			) {
				i.stage = "merged";
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
				return hold(i.id, f.kind, JSON.stringify(f));
			if (i.kind !== "encode" && f.touched.length)
				return hold(
					i.id,
					"protected",
					`Protected paths touched by ${i.id} at ${f.sha}: ${f.touched.join(", ")}`,
				);
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
				summary: e.summary,
				addresses: e.addresses,
			};
			i.stage = "published";
			return verify({
				kind: "published",
				item: i.id,
				sha: f.sha,
				addresses: e.addresses,
				repo: s.repo!,
				head: s.head!,
				mandate: s.mandate!,
				brief: renderReport(s, i, e.summary),
				rulings: i.rulings,
			});
		}
		case "integration":
		case "rework": {
			if (e.item === "full" && s.phase === "handed_off") {
				s.phase = "active";
				s.head = e.head ?? s.head;
				s.coordinator.reason = {
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
			i.input = e.kind;
			i.stage = "building";
			i.evidence = e.evidence;
			i.threads = e.threads;
			i.seq = ++s.seq;
			return { state };
		}
		case "merged": {
			const i = s.items.find((i) => i.id === e.item);
			if (i?.stage !== "published")
				return { reject: "Only a published item can be merged." };
			s.head = e.head;
			i.stage = "cleaning";
			i.retry = 0;
			break;
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
				summary: e.summary,
				risk: e.risk,
			});
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
			return hold(id, "stall", `${agent.key} ${e.cause}: ${e.lastWords}`);
		}
		case "resume": {
			const h = s.holds.find((h) => h.cause === e.cause && h.item === e.item);
			if (!h) return { state };
			s.holds = s.holds.filter((other) => other !== h);
			const direction = ownerDirection({
				direction: e.direction,
				evidence: h.evidence,
			});
			const i = s.items.find((item) => item.id === e.item);
			// Cleanup has no worker. Its finding accompanies the coordinator's next turn.
			const recipient = i && i.stage !== "cleaning" ? i : s.coordinator;
			recipient.direction = [recipient.direction, direction]
				.filter(Boolean)
				.join("\n");
			if (!i) {
				s.coordinator.seq = ++s.seq;
				if (s.phase === "discover" || s.phase === "start") s.setupRetry++;
			} else if (!held(s, i.id)) {
				if (i.stage === "preparing" && h.obstruction === "occupied")
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
	agents,
	view: buildView,
	asks: () => [],
	effects: (s, w) => plans(s, w).map((p) => p.effect),
};
export const buildLane = defineLane(build, buildV1);
