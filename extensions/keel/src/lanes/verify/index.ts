import {
	directions,
	holdingBasis,
	holdingScope,
	holdingSubject,
	resumption,
} from "../../holding.ts";
import { effectKey, token } from "../../kernel/ids.ts";
import {
	type Accepted,
	defineLane,
	type KernelEvent,
	type Lane,
	type LaneEvent,
	type Message,
	type Note,
	type Reduction,
	type World,
} from "../../kernel/lane.ts";
import {
	layout,
	type RepoInfo,
	type RepoResult,
	type Sha,
} from "../../repo/index.ts";
import { toBuild } from "../build/public.ts";
import type { Mandate } from "../design/public.ts";
import { cancelWork, fileIntake } from "../queue/public.ts";
import {
	agentFor,
	agents,
	asks,
	effects,
	handoverEvidence,
} from "./declarations.ts";
import type { FindingNote, HoldingReport, Publication } from "./public.ts";
import {
	type Block,
	cleaning,
	held,
	type Job,
	type Op,
	type Review,
	type State,
	type Target,
	VerifyDoc,
} from "./state.ts";
import { grounds } from "./tools.ts";

export { verifyTools } from "./tools.ts";

type Event =
	| Publication
	| FindingNote
	| HoldingReport
	| { kind: "ambiguity_answer"; direction: string }
	| { kind: "slot_granted" | "cancel" }
	| { kind: "queue_hold"; item: string; cause: string }
	| { kind: "defect_fixed"; item: string; evidence: string }
	| {
			kind: "queue_release";
			cause: string;
			direction?: string;
			except?: string[];
	  }
	| {
			kind: "mandate_revised";
			mandate: Mandate;
			items: string[];
			evidence: string;
	  }
	| {
			kind: "verdict";
			agent: string;
			blocks: Block[];
			notes: string[];
			principlesUnfollowed?: { name: string; thread: string }[];
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

function transition(prev: State, world: World) {
	// A reduction owns its draft. Refusing an inconsistent verdict leaves the prior state intact.
	const s = structuredClone(prev),
		send: Message[] = [],
		notes: Note[] = [];
	const work = world.work!;
	const queue = world.view("queue") as {
		findingsFor?(id: typeof work): string;
		directionsFor?(id: typeof work): string[];
	} | null;
	const deliver = (lane: "design" | "trunk", e: LaneEvent) =>
		send.push({
			lane,
			work: lane === "trunk" ? null : work,
			event: e,
		});
	const note = (text: string) => notes.push({ agent: null, text });
	function file(
		source: "owner" | "verifier",
		sha: Sha,
		item: string | null,
		text: string,
		report: string,
		nodes: string[],
		principle?: true,
	) {
		send.push(
			fileIntake({
				work,
				source,
				sha,
				item,
				text,
				report,
				nodes,
				edgeCase: null,
				pattern: null,
				blocking: false,
				...(principle && { principle }),
			}),
		);
	}
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
	function hold(
		item: string,
		evidence: string,
		resume: string,
		job: string | null = null,
	) {
		const cause = key("hold");
		const basis = holdingBasis({
			goal: s.mandate!.intent,
			scope: holdingScope("verify", item),
			evidence,
			resume,
		});
		s.holds.push({ cause, item, evidence, job, basis });
		recordHold({
			kind: "holding_report",
			lane: "verify",
			item,
			cause,
			evidence,
			direction: null,
		});
	}
	function recordHold({
		lane,
		item,
		cause,
		evidence,
		direction,
	}: HoldingReport) {
		const scope = holdingScope(lane, item);
		s.holdingReports[`${lane}/${cause}`] = {
			scope,
			evidence,
			status: direction === null ? "open" : "resumed",
		};
		if (direction !== null) {
			if (direction.trim())
				s.directions.push(`${scope}: ${evidence}\nDirection: ${direction}`);
			if (item !== null)
				for (const t of s.threads) if (t.item === item) t.survived = 0;
		}
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
		inheritedTrunk?: Sha,
		reason?: import("../build/public.ts").SupersedeReason,
	) {
		c.phase = "returned";
		if (c.scope !== "item") release();
		send.push(
			toBuild(work, {
				kind,
				item: c.item,
				evidence,
				...(c.direction && { direction: c.direction }),
				threads,
				head: s.head!,
				...(inheritedTrunk && { inheritedTrunk }),
				...(reason && { reason }),
			}),
		);
		c.direction = "";
	}
	function resumeReview(c: Review) {
		if (held(s, c.item)) return;
		if (c.phase === "nonconvergent") {
			const prefix = `${c.item} @ ${c.sha}: `;
			const diagnosis = s.diagnoses.findLast((d) => d.startsWith(prefix))!;
			const verdict = s.verdicts.findLast((v) => v.item === c.item)!;
			back(
				c,
				"rework",
				diagnosis.slice(prefix.length),
				verdict.blocks.map((b) => b.thread),
			);
		} else if (c.phase === "verify" || c.phase === "diagnose") c.turn = ++s.seq;
	}
	function mergeReady() {
		if (s.cancelled || s.jobs.some((j) => j.op.kind === "merge_item")) return;
		const c = s.checks.find(
			(c) => c.phase === "ready" && !cleaning(s, c.item) && !held(s, c.item),
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
		const design = world.view("design") as {
			ownerReviewed: boolean;
			reference: string;
			revisionSummary: string;
		} | null;
		s.directions.push(...(queue?.directionsFor?.(work) ?? []));
		s.handover = {
			sha,
			at: world.now,
			unchanged,
			status: "asking",
			followReference:
				design?.ownerReviewed === false ? design.reference : null,
			revisions: design?.revisionSummary ?? "",
			findings: [
				queue?.findingsFor?.(work),
				...Object.values(s.holdingReports).map(
					({ scope, evidence, status }) =>
						`- Holding finding (${scope}): ${evidence} (${status})`,
				),
			]
				.filter(Boolean)
				.join("\n"),
		};
		if (!s.cancelled) deliver("design", { kind: "landed" });
		note(
			`${s.cancelled ? "Cancelled work: " : ""}${unchanged ? "trunk unchanged at" : "landed on trunk at"} ${sha}`,
		);
	}
	function discard(j: Job) {
		s.jobs = s.jobs.filter((other) => other !== j);
	}
	const running = (j: Job) => !!world.runningEffect?.(effectKey(j.key));
	// A retry or an exhausted delivery may already have advanced Git. Preserve its pinned plan.
	const unclaimedMerge = (j: Job) =>
		j.op.kind === "merge_item" &&
		!running(j) &&
		j.key === j.op.key &&
		!s.holds.some((h) => h.job === j.key);
	function withdrawMerge(item: string) {
		const job = s.jobs.find((j) => j.item === item && unclaimedMerge(j));
		if (!job) return;
		discard(job);
		find(item)!.phase = "ready";
	}
	function returnObsolete(c: Review) {
		if (
			s.jobs.some(
				(j) =>
					j.item === c.item &&
					(j.op.kind === "merge_item" ||
						(j.op.kind === "checkout" && running(j))),
			)
		)
			return;
		for (const j of s.jobs.filter(
			(j) => j.item === c.item && j.op.kind === "checkout",
		))
			discard(j);
		for (const h of s.holds.filter(
			(h) =>
				h.item === c.item &&
				(h.job === null || !s.jobs.some((j) => j.key === h.job)),
		)) {
			s.holds = s.holds.filter((other) => other !== h);
			s.holdingReports[`verify/${h.cause}`]!.status = "resolved";
		}
		retire(c);
		back(
			c,
			"rework",
			c.obsolete!.evidence,
			s.verdicts
				.findLast((v) => v.item === c.item)
				?.blocks.map((b) => b.thread) ?? [],
			undefined,
			c.obsolete!.reason,
		);
		c.obsolete = null;
	}
	function clearIntegration(j: Job) {
		const op = j.op;
		if (op.kind === "merge_item" || op.kind === "take_trunk")
			cleanup(j.item, { kind: "checkout", key: op.key, path: op.integration });
	}
	function cancel() {
		s.cancelled = true;
		for (const j of [...s.jobs]) {
			if (j.op.kind === "remove") {
				// A held delivery is complete in the kernel. Retry ownership-safe disposal under a new delivery key.
				if (s.holds.some((h) => h.job === j.key)) j.key = key("remove-retry");
				continue;
			}
			if (running(j)) continue;
			if (j.op.kind === "land" && s.landingUnconfirmed) {
				if (s.holds.some((h) => h.job === j.key)) j.key = key("land-settle");
				continue;
			}
			discard(j);
			clearIntegration(j);
		}
		s.holds = [];
		for (const report of Object.values(s.holdingReports))
			if (report.status === "open") report.status = "cancelled";
		s.queueHolds = [];
		for (const c of s.checks) {
			if (
				!s.jobs.some(
					(j) => j.op.kind === "checkout" && j.op.key === c.checkout?.key,
				)
			)
				retire(c);
		}
		if (!s.jobs.some((j) => j.op.kind === "land")) release();
	}
	function onFact(e: KernelEvent): Accepted<State> {
		if (e.kind === "agent_stalled" || e.kind === "answered") {
			if (s.cancelled) return { state: prev };
			switch (e.kind) {
				case "agent_stalled": {
					const c = s.checks.find(
						(c) =>
							(c.phase === "verify" || c.phase === "diagnose") &&
							agentFor(c) === e.agent &&
							e.token === token(e.agent, c.turn),
					);
					if (c && !held(s, c.item)) {
						c.direction = "";
						hold(
							c.item,
							`${e.agent}: ${e.cause}. ${e.lastWords}`,
							resumption.stalled({ agent: e.agent }).trim(),
						);
					}
					break;
				}

				case "answered": {
					const h = s.holds.find(
						(h) => holdingSubject(work, "verify", h.cause) === e.subject,
					);
					if (h) {
						if (e.choice === "cancel")
							return { state: prev, send: [cancelWork(work)] };
						if (e.choice !== "resume") return { state: prev };
						const direction = directions(e);
						recordHold({
							kind: "holding_report",
							lane: "verify",
							item: h.item,
							cause: h.cause,
							evidence: h.evidence,
							direction,
						});
						const c = find(h.item)!;
						s.holds = s.holds.filter((other) => other !== h);
						c.direction = [
							c.direction,
							c.phase === "nonconvergent" ? "" : h.evidence,
							direction,
						]
							.filter(Boolean)
							.join("\n");
						if (h.job) s.jobs.find((j) => j.key === h.job)!.key = key("retry");
						resumeReview(c);
						break;
					}
					if (s.handover?.status !== "asking" || e.subject !== "handover")
						break;
					if (e.choice !== "accept" && e.choice !== "reject")
						return { state: prev };
					const annotations = e.annotations.filter((a) => a.text.trim());
					if (e.choice === "reject" && !annotations.length) {
						note("Annotate the hand-over to explain why you reject it.");
						break;
					}
					s.handover.status = e.choice === "accept" ? "accepted" : "rejected";
					if (e.choice === "reject") {
						const evidence = handoverEvidence(prev);
						for (const a of annotations)
							file(
								"owner",
								s.handover.sha,
								null,
								a.text,
								`Hand-over annotation ${a.n}.\n\n${evidence}`,
								[],
							);
					}
					deliver("design", { kind: "closed" });
					send.push(toBuild(work, { kind: "closed" }));
					break;
				}
			}
			return settle();
		}

		const j = s.jobs.find((j) => j.key === e.key);
		if (!j || s.holds.some((h) => h.job === j.key)) return { state: prev };
		const r =
			e.kind === "effect_done"
				? (e.result as RepoResult | { kind: "repo"; repo: RepoInfo })
				: null;
		const op = j.op,
			c = find(j.item)!;
		if (op.kind === "land") s.landingUnconfirmed = !r;
		if (s.cancelled) {
			discard(j);
			if (op.kind === "land") {
				if (r?.kind === "landed" || r?.kind === "unchanged")
					landed(r.sha, r.kind === "unchanged");
				else {
					release();
					if (r?.kind === "moved")
						note(
							`Cancelled work: trunk is at ${r.actual ?? "no commit"}. No rollback was attempted.`,
						);
					else
						note(
							`Cancelled work: could not confirm trunk for landing ${op.target}. ${JSON.stringify(r ?? e)}. No rollback was attempted.`,
						);
				}
			} else if (op.kind === "checkout") retire(c);
			else if (op.kind === "remove" && r?.kind !== "removed")
				s.kept.push(`${op.target.path}: ${JSON.stringify(r ?? e)}`);
			else clearIntegration(j);
		} else if (c.obsolete && op.kind === "checkout") {
			discard(j);
			returnObsolete(c);
		} else if (
			!r ||
			r.kind === "occupied" ||
			r.kind === "moved" ||
			r.kind === "kept"
		) {
			hold(
				j.item,
				`${op.kind}: ${JSON.stringify(op)}\n${JSON.stringify(r ?? e)}`,
				resumption.pinned({ operation: op.kind }).trim(),
				j.key,
			);
		} else {
			discard(j);
			switch (op.kind) {
				case "checkout":
					if (r.kind !== "checkout") throw Error("Unexpected checkout result");
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
					clearIntegration(j);
					if (r.kind === "conflict" || r.kind === "checks_failed") {
						if (c.obsolete) {
							c.obsolete.evidence += `\n${JSON.stringify(r, null, 2)}`;
							returnObsolete(c);
							break;
						}
						back(
							c,
							"integration",
							JSON.stringify(r, null, 2),
							[],
							op.kind === "take_trunk" ? op.trunk : undefined,
						);
						break;
					}
					if (op.kind === "merge_item" && r.kind === "merged") {
						s.head = r.sha;
						c.phase = "merged";
						c.obsolete = null;
						send.push(
							toBuild(work, { kind: "merged", item: c.item, head: r.sha }),
						);
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
						hold(
							"full",
							"The pinned trunk branch is absent.",
							resumption.trunk,
							j.key,
						);
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
		return settle();
	}
	function reduce(e: Event): Reduction<State> {
		if (e.kind === "finding_note")
			return { state: prev, notes: [{ agent: null, text: e.text }] };
		if (s.cancelled) return { state: prev };
		if (e.kind === "holding_report") {
			recordHold(e);
			return { state: s };
		}
		switch (e.kind) {
			case "cancel":
				cancel();
				break;
			case "ambiguity_answer":
				s.directions.push(`Ground reading: ${e.direction}`);
				break;
			case "queue_hold":
				if (
					!s.queueHolds.some((h) => h.item === e.item && h.cause === e.cause)
				) {
					s.queueHolds.push({ item: e.item, cause: e.cause });
					withdrawMerge(e.item);
				}
				break;
			case "queue_release": {
				const released = (h: (typeof s.queueHolds)[number]) =>
					h.cause === e.cause && !e.except?.includes(h.item);
				const items = s.queueHolds.filter(released).map((h) => h.item);
				s.queueHolds = s.queueHolds.filter((h) => !released(h));
				for (const item of items) {
					const c = find(item);
					if (!c || !["verify", "diagnose", "nonconvergent"].includes(c.phase))
						continue;
					if (e.direction)
						c.direction = [c.direction, e.direction].filter(Boolean).join("\n");
					resumeReview(c);
				}
				break;
			}
			case "defect_fixed": {
				const c = find(e.item);
				if (!c || c.phase === "merged" || c.phase === "returned") break;
				withdrawMerge(c.item);
				c.obsolete = { evidence: e.evidence, reason: "defect_fixed" };
				returnObsolete(c);
				break;
			}
			case "mandate_revised": {
				const proofChanged =
					JSON.stringify(e.mandate.checks) !==
					JSON.stringify(s.mandate?.checks);
				s.mandate = e.mandate;
				for (const c of s.checks) {
					if (
						c.scope !== "item" ||
						c.phase === "merged" ||
						c.phase === "returned"
					)
						continue;
					const affected = e.items.includes(c.item);
					if (proofChanged || affected) withdrawMerge(c.item);
					if (!affected) continue;
					c.obsolete = { evidence: e.evidence, reason: "mandate_revision" };
					returnObsolete(c);
				}
				break;
			}
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
					base: e.base,
					sha: full ? e.head : e.sha,
					brief: full ? e.summary : e.brief,
					paths: full ? [] : e.paths,
					nodes: full ? [] : (e.nodes ?? []),
					obsolete: null,
					rulings: e.rulings,
					addresses,
					direction: full
						? s.checks
								.map((other) => other.direction)
								.filter(Boolean)
								.join("\n")
						: "",
					changedPolicyFiles: full ? [] : e.changedPolicyFiles,
					phase: "checkout",
					turn: 0,
					checkout: null,
					playbook: null,
				};
				if (full) for (const prior of s.checks) prior.direction = "";
				s.checks = s.checks.filter((x) => x !== old);
				s.checks.push(c);
				if (full)
					s.handoff = {
						base: e.base,
						summary: e.summary,
						risk: e.risk,
						rulings: e.rulings,
						approvals: e.approvals,
					};
				checkout(c);
				break;
			}
			case "verdict": {
				const c = s.checks.find(
					(c) =>
						c.phase === "verify" && agentFor(c) === e.agent && !held(s, c.item),
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
				const unfollowed = e.principlesUnfollowed ?? [];
				if (unfollowed.some((p) => !p.name.trim() || !ids.includes(p.thread)))
					return {
						reject:
							"Name the existing block thread for each unfollowed principle.",
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
				for (const text of e.notes)
					file(
						"verifier",
						c.sha,
						c.scope === "item" ? c.item : null,
						text,
						e.text,
						c.nodes,
					);
				for (const p of unfollowed)
					file(
						"verifier",
						c.sha,
						c.scope === "item" ? c.item : null,
						`Clarify or bind principle ${p.name}.`,
						`${p.thread}: ${blocks.find((b) => b.thread === p.thread)!.evidence}\n\n${e.text}`,
						c.nodes,
						true,
					);
				// The agent that just answered has received its direction.
				c.direction = "";
				if (e.outcome === "pass") {
					retire(c);
					c.phase = c.scope === "item" ? "ready" : "passed";
					if (c.scope === "item")
						send.push(toBuild(work, { kind: "item_verified", item: c.item }));
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
						!held(s, c.item),
				);
				if (!c || ![e.premise, e.test, e.result].every((x) => x.trim()))
					return {
						reject: "A fresh diagnosis needs its premise, test and result.",
					};
				const v = s.verdicts.findLast((v) => v.item === c.item)!;
				c.phase = "nonconvergent";
				c.direction = "";
				const diagnosis = `Two claimed fixes failed on ${v.diagnose.join(", ")}. ${JSON.stringify(v.blocks)}\nPremise: ${e.premise}\nTest: ${e.test}\nResult: ${e.result}`;
				s.diagnoses.push(`${c.item} @ ${c.sha}: ${diagnosis}`);
				hold(c.item, diagnosis, resumption.diagnosis);
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
		}
		return settle();
	}
	function settle(): Accepted<State> {
		if (s.cancelled && !s.jobs.length)
			deliver("design", {
				kind: "cleanup_finished",
				lane: "verify",
				kept: s.kept,
			});
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
	}
	return { reduce, onFact };
}
export const verify: Lane<State> = {
	name: "verify",
	state: VerifyDoc,
	agents,
	asks,
	effects,
	view: (s) => ({
		landed: s.handover?.sha ?? null,
		landedAt: s.cancelled ? null : (s.handover?.at ?? null),
	}),
	reduce: (s, e, w) => transition(s, w).reduce(e as Event),
	onFact: (s, e, w) => transition(s, w).onFact(e),
};
export const verifyLane = defineLane(verify);
