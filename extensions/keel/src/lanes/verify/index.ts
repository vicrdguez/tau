import { token } from "../../kernel/ids.ts";
import {
	defineLane,
	type KernelEvent,
	type Lane,
	type LaneEvent,
	type Message,
	type Note,
} from "../../kernel/lane.ts";
import {
	layout,
	type RepoInfo,
	type RepoResult,
	type Sha,
} from "../../repo/index.ts";
import type { Ruling } from "../build/public.ts";
import type { Mandate } from "../design/public.ts";
import { agentFor, agents, asks, effects } from "./declarations.ts";
import { verifyFixture } from "./fixture.ts";
import {
	type Block,
	cleaning,
	type Op,
	type Review,
	type State,
	type Target,
	VerifyDoc,
} from "./state.ts";
import { grounds } from "./tools.ts";

export { verifyTools } from "./tools.ts";

type Context = {
	repo: RepoInfo;
	mandate: Mandate;
	head: Sha;
	rulings: Ruling[];
};
type Event =
	| KernelEvent
	| ({
			kind: "published";
			item: string;
			sha: Sha;
			addresses: string[];
			brief: string;
	  } & Context)
	| ({ kind: "handoff"; base: Sha; summary: string; risk: string } & Context)
	| { kind: "slot_granted" | "cancel" }
	| {
			kind: "resume";
			cause: string;
			item: string;
			direction: string;
			evidence: string;
	  }
	| { kind: "reset_counts"; item: string }
	| {
			kind: "verdict";
			agent: string;
			blocks: Block[];
			notes: string[];
			outcome: "pass" | "fail";
			text: string;
	  }
	| {
			kind: "diagnosis";
			agent: string;
			premise: string;
			test: string;
			result: string;
	  };

export const verify: Lane<State> = {
	name: "verify",
	state: VerifyDoc,
	agents,
	asks,
	effects,
	view: (s) => ({ landed: s.handover?.sha ?? null }),
	reduce(prev, event, world) {
		// A reduction owns its draft. Refusing an inconsistent verdict leaves the prior state intact.
		const s = structuredClone(prev),
			send: Message[] = [],
			notes: Note[] = [];
		const work = world.work!;
		const deliver = (lane: string, e: LaneEvent) =>
			send.push({
				lane,
				work: lane === "trunk" || lane === "queue" ? null : work,
				event: e,
			});
		const note = (text: string) => notes.push({ agent: null, text });
		const key = (name: string) => `verify/${work}/${name}/${++s.seq}`;
		const find = (item: string) => s.checks.find((c) => c.item === item);
		const enqueue = (item: string, op: Op) =>
			s.jobs.push({ item, op, key: op.key });
		const cleanup = (item: string, target: Target) =>
			enqueue(item, { kind: "remove", key: key("remove"), target });
		function retire(c: Review) {
			if (c.checkout) {
				cleanup(c.item, c.checkout);
				c.checkout = null;
			}
		}
		function checkout(c: Review) {
			const k = key("checkout");
			c.checkout = {
				kind: "checkout",
				key: k,
				path: layout.worktree(s.repo!, String(work), `verifier-${s.seq}`),
				sha: c.sha,
			};
			c.phase = "checkout";
			c.playbook = null;
			enqueue(c.item, c.checkout);
		}
		function hold(item: string, evidence: string, job: string | null = null) {
			const cause = key("hold");
			s.holds.push({ cause, item, evidence, job });
			deliver("queue", {
				kind: "file",
				work,
				lane: "verify",
				item,
				cause,
				evidence,
			});
		}
		function release() {
			if (s.slot !== "none") deliver("trunk", { kind: "release_slot", work });
			s.slot = "none";
		}
		function back(
			c: Review,
			kind: "rework" | "integration",
			evidence: string,
			threads: string[],
		) {
			c.phase = "returned";
			if (c.scope !== "item") release();
			deliver("build", {
				kind,
				item: c.item,
				evidence,
				threads,
				head: s.head!,
			});
		}
		function mergeReady() {
			if (s.cancelled || s.jobs.some((j) => j.op.kind === "merge_item")) return;
			const c = s.checks.find(
				(c) =>
					c.phase === "ready" &&
					!cleaning(s, c.item) &&
					!s.holds.some((h) => h.item === c.item),
			);
			if (!c) return;
			const k = key("merge");
			c.phase = "merging";
			enqueue(c.item, {
				kind: "merge_item",
				key: k,
				integration: layout.integration(s.repo!, String(work), k),
				into: layout.buildBranch(String(work)),
				expected: s.head!,
				item: c.sha,
				checks: s.mandate!.checks,
				message: `Merge item ${c.item}`,
			});
		}
		function cas() {
			enqueue("full", { kind: "land", ...s.plan!, target: s.target! });
		}
		function landed(sha: Sha, unchanged: boolean) {
			release();
			s.handover = { sha, unchanged, status: "asking", missing: [] };
			note(
				`${s.cancelled ? "Cancelled work: " : ""}${unchanged ? "trunk unchanged at" : "landed on trunk at"} ${sha}`,
			);
		}
		const e = event as Event;
		if (e.kind === "cancel") {
			s.cancelled = true;
			// The kernel does not interrupt a running write. Keep the slot and the exact CAS until its result arrives.
			if (
				!s.jobs.some(
					(j) => j.op.kind === "land" && !s.holds.some((h) => h.job === j.key),
				)
			)
				release();
			for (const c of s.checks) {
				if (c.phase !== "checkout") retire(c);
			}
		} else if (e.kind === "effect_done" || e.kind === "effect_failed") {
			const j = s.jobs.find((j) => j.key === e.key);
			if (!j || s.holds.some((h) => h.job === j.key)) return { state: prev };
			const r =
				e.kind === "effect_done"
					? (e.result as RepoResult | { kind: "repo"; repo: RepoInfo })
					: null;
			const op = j.op,
				c = find(j.item)!;
			const finish = () => {
				s.jobs = s.jobs.filter((job) => job !== j);
			};
			const clearIntegration = () => {
				if (op.kind === "merge_item" || op.kind === "take_trunk")
					cleanup(j.item, {
						kind: "checkout",
						key: op.key,
						path: op.integration,
					});
			};
			if (s.cancelled) {
				finish();
				if (op.kind === "land") {
					if (r?.kind === "landed" || r?.kind === "unchanged")
						landed(r.sha, r.kind === "unchanged");
					else {
						release();
						note(
							`Cancelled work: landing result ${JSON.stringify(r ?? e)}. No rollback was attempted.`,
						);
					}
				} else if (op.kind === "checkout" && r?.kind === "checkout") retire(c);
				else if (op.kind === "merge_item" || op.kind === "take_trunk")
					clearIntegration();
				else if (r?.kind !== "removed")
					note(`Cancelled work: ${op.kind}: ${JSON.stringify(r ?? e)}`);
			} else if (
				!r ||
				r.kind === "occupied" ||
				r.kind === "moved" ||
				r.kind === "kept"
			) {
				hold(
					j.item,
					`${op.kind}: ${JSON.stringify(op)}\n${JSON.stringify(r ?? e)}`,
					j.key,
				);
			} else {
				finish();
				switch (op.kind) {
					case "checkout":
						if (r.kind !== "checkout")
							throw Error("Unexpected checkout result");
						c.playbook = r.playbook;
						c.turn = ++s.seq;
						c.phase = "verify";
						break;
					case "remove":
						if (r.kind !== "removed")
							throw Error("Unexpected checkout removal result");
						break;
					case "merge_item":
					case "take_trunk": {
						clearIntegration();
						if (r.kind === "conflict" || r.kind === "checks_failed") {
							back(c, "integration", JSON.stringify(r, null, 2), []);
							break;
						}
						if (op.kind === "merge_item" && r.kind === "merged") {
							s.head = r.sha;
							c.phase = "merged";
							deliver("build", { kind: "merged", item: c.item, head: r.sha });
							break;
						}
						if (op.kind === "take_trunk" && r.kind === "combined") {
							s.head = r.sha;
							s.plan = {
								key: key("land"),
								combined: r.sha,
								expectedTrunk: r.trunk,
								message: s.handoff!.summary,
							};
							enqueue("full", {
								kind: "prepare_landing",
								key: key("prepare"),
								landing: s.plan,
							});
							break;
						}
						throw Error("Unexpected integration result");
					}
					case "read_repo": {
						if (r.kind !== "repo") throw Error("Unexpected discovery result");
						const trunk = r.repo.trunkHead;
						if (trunk === null) {
							s.jobs.push(j);
							hold("full", "The pinned trunk branch is absent.", j.key);
							break;
						}
						const k = key("take");
						enqueue("full", {
							kind: "take_trunk",
							key: k,
							integration: layout.integration(s.repo!, String(work), k),
							build: layout.buildBranch(String(work)),
							expected: s.head!,
							trunk,
							checks: s.mandate!.checks,
						});
						break;
					}
					case "prepare_landing": {
						if (r.kind === "unchanged") {
							landed(r.sha, true);
							break;
						}
						if (r.kind !== "prepared")
							throw Error("Unexpected preparation result");
						s.target = r.sha;
						if (s.plan!.expectedTrunk !== s.handoff!.base) {
							c.scope = "landing";
							c.sha = r.sha;
							c.base = s.plan!.expectedTrunk;
							checkout(c);
						} else cas();
						break;
					}
					case "land":
						if (r.kind !== "landed" && r.kind !== "unchanged")
							throw Error("Unexpected CAS result");
						landed(r.sha, r.kind === "unchanged");
						break;
				}
			}
		} else if (s.cancelled) return { state: prev };
		else
			switch (e.kind) {
				case "published":
				case "handoff": {
					const full = e.kind === "handoff",
						item = full ? "full" : e.item;
					const old = find(item);
					if (old && old.phase !== "returned" && old.phase !== "merged")
						return { reject: `${item} is not awaiting a publication` };
					s.repo = e.repo;
					s.mandate = e.mandate;
					s.head = e.head;
					// Superseding work makes the previous failed checkout disposable, including a failed full-set review.
					if (old) retire(old);
					const priorFull = find("full");
					if (priorFull?.phase === "returned") retire(priorFull);
					const previousFull = s.verdicts.findLastIndex(
						(v) => v.scope !== "item",
					);
					const addresses = full
						? [
								...new Set(
									s.verdicts
										.slice(previousFull + 1)
										.filter((v) => v.scope === "item")
										.flatMap((v) => v.addresses),
								),
							]
						: e.addresses;
					const c: Review = {
						item,
						scope: full ? "full" : "item",
						base: full ? e.base : e.head,
						sha: full ? e.head : e.sha,
						brief: full ? e.summary : e.brief,
						rulings: e.rulings,
						addresses,
						direction: "",
						phase: "checkout",
						turn: 0,
						checkout: null,
						playbook: null,
					};
					s.checks = s.checks.filter((x) => x !== old);
					s.checks.push(c);
					if (full)
						s.handoff = {
							base: e.base,
							summary: e.summary,
							risk: e.risk,
							rulings: e.rulings,
						};
					checkout(c);
					break;
				}
				case "verdict": {
					const c = s.checks.find(
						(c) =>
							c.phase === "verify" &&
							agentFor(c) === e.agent &&
							!s.holds.some((h) => h.item === c.item),
					);
					if (!c) return { reject: "No active verification" };
					const blocks = e.blocks,
						ids = blocks.map((b) => b.thread);
					if (
						!e.text.trim() ||
						e.notes.some((n) => !n.trim()) ||
						new Set(ids).size !== ids.length ||
						blocks.some(
							(b) =>
								!b.thread.trim() ||
								!b.evidence.trim() ||
								!grounds.some((g) => g === b.ground),
						) ||
						(e.outcome === "pass"
							? blocks.length !== 0
							: e.outcome !== "fail" || !blocks.length)
					)
						return {
							reject:
								"Pass with no blocks, or fail with distinct grounded threads and evidence.",
						};
					const diagnose: string[] = [];
					s.verdicts.push({
						item: c.item,
						scope: c.scope,
						sha: c.sha,
						addresses: c.addresses,
						outcome: e.outcome,
						text: e.text,
						blocks,
						diagnose,
						notes: e.notes,
					});
					if (e.outcome === "pass") {
						retire(c);
						c.phase = c.scope === "item" ? "ready" : "passed";
						break;
					}
					for (const id of ids) {
						const scope = c.scope === "item" ? "item" : "full";
						const t = s.threads.find(
							(t) => t.item === c.item && t.scope === scope && t.id === id,
						);
						if (!t) s.threads.push({ item: c.item, scope, id, survived: 0 });
						else if (c.addresses.includes(id) && ++t.survived >= 2)
							diagnose.push(id);
					}
					if (diagnose.length) {
						if (c.scope === "landing") release();
						c.phase = "diagnose";
						c.turn = ++s.seq;
					} else
						back(
							c,
							"rework",
							`${e.text}\n${JSON.stringify(blocks, null, 2)}`,
							ids,
						);
					break;
				}
				case "diagnosis": {
					const c = s.checks.find(
						(c) =>
							c.phase === "diagnose" &&
							agentFor(c) === e.agent &&
							!s.holds.some((h) => h.item === c.item),
					);
					if (!c || ![e.premise, e.test, e.result].every((x) => x.trim()))
						return {
							reject: "A fresh diagnosis needs its premise, test and result.",
						};
					const v = s.verdicts.findLast((v) => v.item === c.item)!;
					c.phase = "nonconvergent";
					hold(
						c.item,
						`Two claimed fixes failed on ${v.diagnose.join(", ")}. ${JSON.stringify(v.blocks)}\nPremise: ${e.premise}\nTest: ${e.test}\nResult: ${e.result}`,
					);
					break;
				}
				case "slot_granted":
					if (s.slot === "waiting") {
						s.slot = "held";
						enqueue("full", {
							kind: "read_repo",
							key: key("discover"),
							base: s.repo!.base,
							trunk: s.repo!.trunk,
						});
					}
					break;
				case "reset_counts":
					for (const t of s.threads) if (t.item === e.item) t.survived = 0;
					break;
				case "agent_stalled": {
					const c = s.checks.find(
						(c) =>
							(c.phase === "verify" || c.phase === "diagnose") &&
							agentFor(c) === e.agent &&
							e.tokens.includes(token(e.agent, c.turn)),
					);
					if (c && !s.holds.some((h) => h.item === c.item && h.job === null))
						hold(c.item, `${e.agent}: ${e.cause}. ${e.lastWords}`);
					break;
				}
				case "resume": {
					const h = s.holds.find(
						(h) => h.cause === e.cause && h.item === e.item,
					);
					if (!h) break;
					s.holds = s.holds.filter((x) => x !== h);
					const c = find(h.item)!;
					c.direction = [c.direction, h.evidence, e.direction]
						.filter(Boolean)
						.join("\n");
					c.turn = ++s.seq;
					if (h.job) {
						const j = s.jobs.find((j) => j.key === h.job)!;
						j.key = key("retry");
					}
					if (
						c.phase === "nonconvergent" &&
						!s.holds.some((h) => h.item === c.item)
					)
						back(
							c,
							"rework",
							c.direction,
							s.verdicts
								.findLast((v) => v.item === c.item)!
								.blocks.map((b) => b.thread),
						);
					break;
				}
				case "answered": {
					if (s.handover?.status !== "asking" || e.subject !== "handover")
						break;
					if (e.choice !== "accept" && e.choice !== "reject")
						return { reject: "Unknown hand-over choice" };
					if (
						e.choice === "reject" &&
						!e.annotations.some((n) => n.text.trim())
					) {
						note("Reject needs an annotation naming the missing check.");
						break;
					}
					s.handover.status = e.choice === "accept" ? "accepted" : "rejected";
					s.handover.missing =
						e.choice === "reject" ? e.annotations.map((a) => a.text) : [];
					deliver("design", { kind: "closed" });
					deliver("build", { kind: "closed" });
					break;
				}
			}
		mergeReady();
		const full = find("full");
		if (
			full?.phase === "passed" &&
			!s.cancelled &&
			!s.handover &&
			!s.jobs.length &&
			!s.holds.length
		) {
			if (full.scope === "full" && s.slot === "none") {
				s.slot = "waiting";
				deliver("trunk", { kind: "take_slot", work });
			} else if (full.scope === "landing" && s.slot === "held") cas();
		}
		return { state: s, send, notes };
	},
};
export const verifyLane = defineLane(verify, verifyFixture);
