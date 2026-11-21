import { agentKey, subject, token, type WorkId } from "../../kernel/ids.ts";
import {
	type Accepted,
	type AgentDecl,
	type Ask,
	type KernelEvent,
	type LaneEvent,
	type Message,
	prose,
	type Reduction,
	type World,
} from "../../kernel/lane.ts";
import { toBuild } from "../build/public.ts";
import { mandateLabels, renderMandate } from "../design/public.ts";
import { findingNote } from "../verify/public.ts";
import type { ChecksFinished, FindingDisposition, Intake } from "./public.ts";
import {
	cause,
	choices,
	classes,
	close,
	context,
	decisionMembers,
	decisions,
	disposition,
	type Finding,
	type Investigated,
	type Investigation,
	pending,
	type Queue,
	update,
	workChoices,
} from "./state.ts";

const documents = `${import.meta.dirname}/../../prose/documents`;
const investigationSlots = [
	"id",
	"finding",
	"context",
	"queue",
	"patterns",
	"direction",
] as const;
const investigateInput = prose(
	import.meta.dirname,
	"../../prose/inputs/queue/investigate.md",
	investigationSlots,
);
const investigateProject = prose(
	import.meta.dirname,
	"../../prose/inputs/queue/investigate-project.md",
	investigationSlots,
);
const owedDocument = prose(documents, "owed-check.md", [
	"name",
	"work",
	"revision",
	"evidence",
	"outcome",
]);
const triageDocument = prose(documents, "triage.md", [
	"cause",
	"work",
	"choices",
	"findings",
	"nodes",
]);
const noAction = prose(documents, "no-action.md", ["id", "finding", "reason"]);
const stallDocument = prose(documents, "triage-stall.md", [
	"id",
	"finding",
	"cause",
	"lastWords",
]);
const investigator = agentKey("investigator");
const turn = (f: Finding, q: Queue) => token(`investigate/${f.id}`, q.attempt);
const stalled = (f: Finding, q: Queue) =>
	subject(`investigate/${f.id}/${q.attempt}`);
const distinct = <T>(values: T[]) => [...new Set(values)];

function filingText(f: Finding) {
	const {
		text,
		source,
		item,
		sha,
		report,
		nodes,
		edgeCase,
		pattern,
		blocking,
	} = f.intake;
	return [
		`### Finding #${f.id}: ${text}`,
		`Source: ${[source, f.goal ?? "project", item].filter(Boolean).join(" / ")}. Revision: ${sha ?? "not available"}.`,
		nodes.length && `Reported nodes: ${nodes.join(", ")}.`,
		report && `Report: ${report}`,
		edgeCase &&
			`Failure mode: ${edgeCase.failure}\nLikelihood: ${edgeCase.likelihood}\nComplexity cost: ${edgeCase.cost}`,
		pattern && `Pattern: ${pattern}`,
		f.intake.principle && "Principle proposal: route to owner triage.",
		blocking && `The filer could not continue item ${item}.`,
	]
		.filter(Boolean)
		.join("\n");
}
function reportText(f: Finding, q?: Queue) {
	const i = f.investigation;
	const earlier = q?.entries.find((entry) => entry.id === i?.sameAs);
	return [
		filingText(f),
		earlier &&
			(earlier.status !== "triage" || earlier.group !== f.group) &&
			`Linked to #${earlier.id}: ${earlier.intake.text} (${disposition(earlier)}).`,
		i && `Investigation: ${i.evidence}`,
		i?.classification === "determined" && `Reference: ${i.reference}`,
		i?.classification === "mandate_wrong" &&
			`Nodes under review: ${i.nodes.join(", ")}.`,
		i && `Size: ${i.size}. Recommendation: ${i.recommendation}.`,
	]
		.filter(Boolean)
		.join("\n");
}
const evidence = (q: Queue, findings: readonly Finding[]) =>
	findings.map((f) => reportText(f, q)).join("\n\n");
const decisionSubject = (f: Finding) => subject(`triage/${f.id}`);

function hold(f: Finding, nodes: string[], heldCause = cause(f)): Message {
	return toBuild(f.intake.work!, {
		kind: "queue_hold",
		cause: heldCause,
		item: nodes.length ? null : f.intake.item,
		nodes,
		evidence: reportText(f),
	});
}
const hasHold = (f: Finding) =>
	!f.intake.edgeCase &&
	(f.intake.blocking || f.investigation?.classification === "mandate_wrong");
function releases(findings: readonly Finding[], direction?: string): Message[] {
	return findings.flatMap((f) =>
		f.intake.work !== null && hasHold(f) ? [release(f, direction)] : [],
	);
}
const release = (f: Finding, direction?: string) =>
	toBuild(f.intake.work!, {
		kind: "queue_release",
		cause: cause(f),
		...(direction && { direction }),
	});
const reportedNodes = (findings: readonly Finding[]) =>
	distinct(
		findings.flatMap((f) =>
			f.investigation?.nodes.length ? f.investigation.nodes : f.intake.nodes,
		),
	);
function plan(
	first: Finding,
	findings: Finding[],
	text: string,
	reference: string | null,
): Message {
	return toBuild(first.intake.work!, {
		kind: "plan_finding",
		text,
		reference: reference ?? "Current Mandate",
		nodes: reportedNodes(findings),
		...((reference === null || findings.some((f) => f.intake.blocking)) && {
			cause: cause(first),
		}),
	});
}
function seed(
	route: "follow" | "precedent",
	text: string,
	reference: string | null,
	owed?: number[],
): Message {
	return {
		lane: "design",
		work: "new",
		event: {
			kind: "queue_seed",
			route,
			text,
			reference,
			...(owed && { owed }),
		},
	};
}

const isOwed = (f: Finding) =>
	f.intake.missingCheck &&
	f.disposition !== "dropped" &&
	f.disposition !== "encoded";
const beingBuilt = (f: Finding) =>
	isOwed(f) && f.disposition === "build: routed";

function owedTriage(f: Finding, outcome = ""): Finding {
	return {
		...f,
		status: "triage",
		group: f.id,
		disposition: null,
		basis: owedDocument({
			name: f.intake.text,
			work: f.goal ?? "unnamed work",
			revision: f.intake.sha ?? "not available",
			evidence:
				f.intake.report
					?.trim()
					.split("\n")
					.map((line) => (line ? `> ${line}` : ">"))
					.join("\n") ?? "",
			outcome: outcome ? `\n\n${outcome}` : "",
		}),
	};
}

export function finishChecks(
	q: Queue,
	{ ids, encoded, outcome }: ChecksFinished,
): Queue {
	return {
		...q,
		entries: q.entries.map((f) =>
			!beingBuilt(f) || !ids.includes(f.id)
				? f
				: encoded.includes(f.id)
					? { ...f, ...close("encoded") }
					: owedTriage(f, outcome),
		),
	};
}

export function intake(
	q: Queue,
	e: Intake & { requestedOwner?: boolean },
	world: World,
): Reduction<Queue> {
	if (e.requestedOwner && e.source !== "owner")
		return {
			reject: "Only the work's designer can file on behalf of the owner.",
		};
	if (!e.text.trim()) return { reject: "Name the finding." };
	if (
		e.edgeCase &&
		(!e.edgeCase.failure.trim() ||
			!e.edgeCase.likelihood.trim() ||
			!e.edgeCase.cost.trim())
	)
		return {
			reject:
				"An unlikely edge case needs its failure mode, likelihood and complexity cost.",
		};
	if (
		e.blocking &&
		(e.edgeCase ||
			e.work === null ||
			!e.item ||
			!["worker", "verifier"].includes(e.source))
	)
		return {
			reject:
				"Only a worker or verifier's own item can block. File an unlikely edge case without blocking.",
		};
	const pattern = e.pattern?.trim() || null;
	const precedent = q.patterns.find((p) => p.name === pattern);
	const counterexample = e.source === "owner" || e.source === "sweeper";
	if (precedent?.status === "blessed" && !counterexample)
		return {
			state: q,
			reply: `Approved reference: ${pattern}. No finding filed.`,
		};
	const input: Finding["intake"] = {
		work: e.work,
		source: e.source,
		item: e.item,
		sha: e.sha,
		text: e.text.trim(),
		report: e.report?.trim() || null,
		nodes: distinct(e.nodes).sort(),
		edgeCase: e.edgeCase,
		pattern,
		blocking: e.blocking,
		missingCheck: e.missingCheck && e.source === "owner" ? true : null,
		principle:
			e.principle && (e.source === "sweeper" || e.source === "verifier")
				? true
				: null,
	};
	const sameCheck =
		input.missingCheck &&
		q.entries.find((f) => isOwed(f) && f.intake.text === input.text);
	if (sameCheck)
		return { state: q, reply: `Already owed as finding #${sameCheck.id}.` };
	const serialized = JSON.stringify(input);
	const prior = q.entries.findLast(
		(f) => JSON.stringify(f.intake) === serialized,
	);
	if (prior && !input.missingCheck && prior.disposition !== "deferred")
		return { state: q, reply: `Already filed as finding #${prior.id}.` };
	const live = context(world, input.work);
	let f: Finding = {
		id: q.entries.length + 1,
		intake: input,
		goal: input.work === null ? null : (live.goal ?? "unnamed work"),
		basis: null,
		status: "filed",
		investigation: null,
		group: null,
		disposition: null,
		deferredAt: null,
		triageDirection: "",
		revisit: false,
	};
	if (input.missingCheck) f = owedTriage(f);
	if (
		precedent?.status === "revoked" &&
		!counterexample &&
		f.intake.work !== null &&
		live.active
	) {
		const text = `Rework this ruling: the owner revoked ${pattern}.\n\n${filingText(f)}`;
		return {
			state: {
				...q,
				entries: [
					...q.entries,
					{
						...f,
						status: "defect",
						group: f.id,
					},
				],
			},
			send: [
				...(input.blocking ? [hold(f, [])] : []),
				plan(f, [f], text, null),
			],
			reply: `Pattern ${pattern} was revoked. Finding #${f.id} goes to rework.`,
		};
	}
	return {
		state: { ...q, entries: [...q.entries, f] },
		send: input.blocking ? [hold(f, [])] : [],
		reply: `Filed finding #${f.id}.`,
	};
}

const deferredAge = 30 * 86_400_000;
export function revisit(q: Queue, world: World): Queue {
	const due = q.entries.filter(
		(f) =>
			!f.intake.missingCheck &&
			f.deferredAt != null &&
			world.now - f.deferredAt >= deferredAge,
	);
	if (!due.length) return q;
	const ids = due.map((f) => f.id);
	const filed = intake(
		q,
		{
			work: null,
			source: "sweeper",
			item: null,
			sha: null,
			text: "Review long-deferred findings",
			report: evidence(q, due),
			nodes: [],
			edgeCase: null,
			pattern: null,
			blocking: false,
		},
		world,
	);
	if (filed.reject !== undefined || filed.state === q) return q;
	const entries = filed.state.entries.map((f) =>
		ids.includes(f.id) ? { ...f, deferredAt: null } : f,
	);
	const first = entries.at(-1)!;
	first.revisit = true;
	first.status = "triage";
	first.group = first.id;
	first.investigation = {
		classification: "sets_precedent",
		cause: "long-deferred findings",
		recommendation: "defer",
		size: "review the listed findings",
		evidence: "These findings have been deferred for at least 30 days.",
		reference: null,
		nodes: [],
		sameAs: null,
	};
	first.basis = triageBasis(q, first, [first], context(world, null));
	return { ...q, entries };
}

function shareDecision(f: Finding, i: Investigation, other: Finding) {
	if (
		f.intake.missingCheck ||
		other.intake.missingCheck ||
		i.classification !== other.investigation?.classification
	)
		return false;
	switch (i.classification) {
		case "mandate_wrong":
			return other.intake.work === f.intake.work;
		case "determined":
			return (
				other.intake.work === f.intake.work &&
				i.reference === other.investigation.reference
			);
		case "unapproved_pattern":
			return other.intake.pattern === f.intake.pattern;
		case "sets_precedent":
			return true;
		default:
			return false;
	}
}

function revision(findings: Finding[], text: string): Message {
	return {
		lane: "design",
		work: findings[0]!.intake.work,
		event: {
			kind: "revise_mandate",
			causes: findings.map(cause),
			nodes: distinct(findings.flatMap((f) => f.investigation?.nodes ?? [])),
			text,
		},
	};
}

export function classify(
	q: Queue,
	e: Investigated,
	world: World,
): Reduction<Queue> {
	const f = pending(q);
	if (!f || q.stall || f.id !== e.finding)
		return { reject: "Report the finding assigned in your current input." };
	const earlier =
		e.sameAs == null
			? undefined
			: q.entries.find((entry) => entry.id === e.sameAs && entry.id < f.id);
	if (e.sameAs != null && (!earlier || earlier.status === "filed"))
		return {
			reject: "Name an investigated earlier finding with the same cause.",
		};
	const i: Investigation = {
		classification: e.classification,
		nodes: distinct(e.nodes),
		evidence: e.evidence.trim(),
		size: e.size.trim(),
		cause: e.cause.trim() || earlier?.investigation?.cause || "",
		recommendation: e.recommendation,
		reference: e.reference?.trim() || earlier?.investigation?.reference || null,
		sameAs: earlier?.id ?? null,
	};
	if (
		!classes.includes(i.classification) ||
		!i.evidence ||
		!i.size ||
		(!i.cause && i.classification !== "no_action")
	)
		return {
			reject: "Name the class, evidence, estimated size and decision cause.",
		};
	if (!choices(i.classification).some((c) => c === i.recommendation))
		return { reject: "Recommend a choice available for this class." };
	if (i.classification === "determined" && !i.reference)
		return {
			reject: "Name the approved reference that determines this finding.",
		};
	if (Boolean(f.intake.pattern) !== (i.classification === "unapproved_pattern"))
		return {
			reject:
				"Use the unapproved pattern class only when the filing names a pattern.",
		};

	if (f.intake.principle && i.classification !== "sets_precedent")
		return {
			reject: "A principle proposal goes to the owner as sets_precedent.",
		};
	const found = { ...f, investigation: i };
	const work = f.intake.work;
	if (i.classification === "no_action") {
		if (
			work === null ||
			earlier ||
			f.intake.source === "owner" ||
			f.intake.blocking ||
			i.nodes.length
		)
			return {
				reject:
					"No action is for an unlinked observation on a work, not one from the owner, holding a filer, or changing a binding node.",
			};
		const afterHandover = (
			world.view("verify", work) as { landed?: string } | null
		)?.landed;
		return {
			state: update(q, f, { ...found, ...close(`no action: ${i.evidence}`) }),
			...(afterHandover && {
				send: [
					findingNote(
						work,
						noAction({
							id: String(f.id),
							finding: f.intake.text,
							reason: i.evidence,
						}),
					),
				],
			}),
		};
	}

	const live = context(world, work);
	if (
		earlier?.status === "defect" &&
		earlier.investigation?.classification !== "determined"
	) {
		if (
			i.classification !== "defect_in_scope" ||
			work !== earlier.intake.work ||
			!live.active
		)
			return { reject: "Link only the same in-scope defect in this build." };
		const shared = `queue/${earlier.group}`;
		if (f.intake.blocking) {
			const required = new Set(live.plannedFor?.(shared));
			for (const id of required)
				for (const dep of live.plan.find((item) => item.id === id)?.deps ?? [])
					required.add(dep);
			if (required.has(f.intake.item!))
				return {
					reject: `Item ${f.intake.item} is part of the fix for ${shared} or a dependency of it. Report this defect without linking so it gets its own fix.`,
				};
		}
		return {
			state: update(q, f, { ...found, status: "defect", group: earlier.group }),
			// Move the filer to the shared cause before releasing its provisional hold.
			send: f.intake.blocking ? [hold(found, [], shared), release(found)] : [],
		};
	}
	if (!earlier && work !== null && i.classification === "defect_in_scope") {
		if (!live.active)
			return {
				reject: "An in-scope defect must go directly to an active build.",
			};
		return {
			state: update(q, f, { ...found, status: "defect", group: f.id }),
			send: [plan(f, [found], reportText(found), null)],
		};
	}
	if (i.classification === "mandate_wrong" && work !== null) {
		const labels = live.mandate ? mandateLabels(live.mandate) : [];
		if (!i.nodes.length || i.nodes.some((n) => !labels.includes(n)))
			return { reject: "Name binding nodes of the current Mandate." };
	}

	const joining = earlier?.status === "triage";
	if (joining && !shareDecision(f, i, earlier))
		return {
			reject:
				"Name a finding with the same decision, authority and destination.",
		};
	const group = joining ? earlier.group! : f.id;
	const state = update(q, f, { ...found, status: "triage", group });
	const related = decisionMembers(state, group);
	const first = related[0]!;
	return {
		state: update(state, first, {
			basis: triageBasis(state, first, related, live),
		}),
		send:
			live.active && i.classification === "mandate_wrong" && !f.intake.edgeCase
				? [hold(found, i.nodes)]
				: [],
	};
}

export function recordDisposition(q: Queue, e: FindingDisposition): Queue {
	return {
		...q,
		entries: q.entries.map((f) =>
			f.intake.work === e.work &&
			((f.status === "revision" && e.causes.includes(cause(f))) ||
				(f.status === "defect" && e.causes.includes(`queue/${f.group}`)))
				? { ...f, ...close(e.disposition) }
				: f,
		),
	};
}

export function cancelWork(q: Queue, work: WorkId): Queue {
	return {
		...q,
		entries: q.entries.map((f) =>
			f.intake.work === work &&
			(f.status === "defect" ||
				f.status === "revision" ||
				(f.status === "triage" &&
					f.investigation?.classification === "mandate_wrong"))
				? { ...f, ...close("cancelled") }
				: f,
		),
	};
}

export function onFact(
	q: Queue,
	fact: KernelEvent,
	world: World,
): Accepted<Queue> {
	const f = pending(q);
	if (fact.kind === "agent_stalled") {
		if (
			!q.stall &&
			f &&
			fact.agent === investigator &&
			fact.tokens.includes(turn(f, q))
		)
			return {
				state: {
					...q,
					stall: { cause: fact.cause, lastWords: fact.lastWords },
				},
			};
		return { state: q };
	}
	if (fact.kind !== "answered") return { state: q };
	if (f && q.stall && fact.subject === stalled(f, q)) {
		if (fact.choice === "resume") {
			const direction = [
				q.direction,
				...fact.annotations.map((a) => `${a.n}. ${a.text}`),
			]
				.filter(Boolean)
				.join("\n");
			return {
				state: { ...q, attempt: q.attempt + 1, stall: null, direction },
			};
		}
		if (fact.choice === "cancel")
			return {
				state: update({ ...q, stall: null, direction: "" }, f, {
					...close("dropped"),
				}),
				send: releases([f], "The owner cancelled the investigation."),
			};
		return { state: q };
	}
	const first = decisions(q).find((f) => decisionSubject(f) === fact.subject);
	if (!first) return { state: q };
	if (first.intake.missingCheck) {
		switch (fact.choice) {
			case "build": {
				const direction = fact.annotations
					.map((a) => `${a.n}. ${a.text}`)
					.join("\n");
				return {
					state: update(q, first, close("build: routed")),
					send: [
						seed(
							"follow",
							[
								first.intake.report,
								direction && `Owner direction:\n${direction}`,
							]
								.filter(Boolean)
								.join("\n\n"),
							first.intake.text,
							[first.id],
						),
					],
				};
			}
			case "defer":
			case "drop":
				return {
					state: update(
						q,
						first,
						close(fact.choice === "drop" ? "dropped" : "deferred"),
					),
				};
			default:
				return { state: q };
		}
	}
	const i = first.investigation!;
	if (!choices(i.classification).some((c) => c === fact.choice))
		return { state: q };
	const related = decisionMembers(q, first.id);
	const annotations = fact.annotations
		.map((a) => `${a.n}. ${a.text}`)
		.join("\n");
	const text = [
		evidence(q, related),
		annotations && `Owner direction:\n${annotations}`,
	]
		.filter(Boolean)
		.join("\n\n");
	const active = context(world, first.intake.work).active;
	const building = fact.choice === "build";
	const revising = building && active && i.classification === "mandate_wrong";
	const defect = i.classification === "defect_in_scope";
	const planning =
		building && active && (defect || i.classification === "determined");
	const fixing = planning && (defect || related.some((f) => f.intake.blocking));
	const pattern = ["bless", "revoke"].includes(fact.choice)
		? first.intake.pattern
		: null;
	const outcome =
		{
			build: "build: routed",
			drop: "dropped",
			defer: "deferred",
			bless: "blessed",
			revoke: "pattern revoked",
		}[fact.choice] ?? fact.choice;
	const state: Queue = {
		...q,
		entries: q.entries.map((entry) => {
			if (related.includes(entry)) {
				const next = revising
					? { ...close(outcome), status: "revision" as const }
					: fixing
						? { ...close(outcome), status: "defect" as const, group: first.id }
						: close(outcome);
				return {
					...entry,
					...next,
					triageDirection:
						annotations &&
						entry.intake.work !== null &&
						related.find((f) => f.intake.work === entry.intake.work) === entry
							? [entry.triageDirection, annotations].filter(Boolean).join("\n")
							: (entry.triageDirection ?? ""),
					deferredAt:
						fact.choice === "defer" && !entry.revisit ? world.now : null,
				};
			}
			return entry;
		}),
		patterns: pattern
			? [
					...q.patterns.filter((p) => p.name !== pattern),
					{
						name: pattern,
						finding: first.id,
						evidence: text,
						status: fact.choice === "bless" ? "blessed" : "revoked",
					},
				]
			: q.patterns,
	};
	if (revising)
		return {
			state,
			send: [
				...related.map((entry) => hold(entry, entry.investigation!.nodes)),
				revision(related, text),
			],
		};
	if (planning)
		return {
			state,
			send: [
				...related
					.filter((f) => f !== first && f.intake.blocking)
					.flatMap((f) => [hold(f, [], cause(first)), release(f)]),
				plan(first, related, text, defect ? null : i.reference!),
			],
		};

	const send: Message[] = [];
	if (building) {
		if (i.classification === "determined")
			send.push(seed("follow", text, i.reference));
		else send.push(seed("precedent", text, null));
	}
	if (fact.choice === "revoke")
		send.push(
			seed(
				"precedent",
				`Make the pattern ${pattern} fail structurally and migrate its callers.\n\n${text}`,
				null,
			),
		);
	return { state, send: [...send, ...releases(related, annotations)] };
}

function actions(classification: Investigation["classification"]) {
	switch (classification) {
		case "determined":
			return "Build adds work to the related active build or starts new work under the approved reference. Defer parks it. Drop closes it.";
		case "defect_in_scope":
			return "Build asks the coordinator to plan a fix if the build is active, or starts follow-up design. Defer releases holds and parks the finding. Drop releases holds and closes it.";
		case "mandate_wrong":
			return "Build asks the designer to propose a revision, or starts follow-up design if the build has handed off. Defer releases holds and parks the finding. Drop releases holds and closes it.";
		case "unapproved_pattern":
			return "Bless makes this an approved reference. Revoke starts work to make the pattern fail structurally. Defer parks the finding.";
		default:
			return "Build starts new work with design and Mandate review. Defer parks it. Drop closes it.";
	}
}
function triageBasis(
	q: Queue,
	first: Finding,
	related: Finding[],
	live: ReturnType<typeof context>,
) {
	const i = first.investigation!;
	const nodes = reportedNodes(related);
	return triageDocument({
		cause: distinct(related.map((f) => f.investigation!.cause)).join("; "),
		work: first.goal ?? "the project queue",
		choices: first.revisit
			? "Build starts new work with design and Mandate review. Defer and drop both close this list without scheduling work or listing these findings again."
			: i.classification === "mandate_wrong" && !live.active
				? "Build starts follow-up design. This finding does not hold the landing. Defer parks it. Drop closes it."
				: actions(i.classification),
		findings: [
			first.intake.pattern &&
				q.patterns.find(
					(p) => p.name === first.intake.pattern && p.status === "blessed",
				) &&
				`This pattern is blessed until you revoke it.`,
			evidence(q, related),
		]
			.filter(Boolean)
			.join("\n\n"),
		nodes:
			live.mandate && nodes.length
				? `## Mandate nodes\n\n${renderMandate(live.mandate, nodes)}`
				: "",
	});
}

// A queued investigation depends on the investigator finishing the head first.
const queuedWorks = (q: Queue) =>
	q.entries.filter((f) => f.status === "filed").map((f) => f.intake.work);

export function asks(q: Queue): Ask[] {
	const out: Ask[] = decisions(q).map((first) => {
		const basis = first.basis!;
		return {
			subject: decisionSubject(first),
			title: basis.split("\n", 1)[0]!,
			basis,
			choices: first.intake.missingCheck
				? workChoices
				: choices(first.investigation!.classification),
			works: decisionMembers(q, first.id).map((f) => f.intake.work),
		};
	});
	const f = pending(q);
	if (q.stall && f) {
		const basis = stallDocument({
			id: String(f.id),
			finding: filingText(f),
			...q.stall,
		});
		out.push({
			subject: stalled(f, q),
			title: basis.split("\n", 1)[0]!,
			basis,
			choices: ["resume", "cancel"],
			works: queuedWorks(q),
		});
	}
	return out;
}
export function begin(q: Queue, world: World): Queue {
	const f = pending(q);
	if (!f) return { ...q, context: "" };
	const { mandate, plan, reference } = context(world, f.intake.work);
	return {
		...q,
		direction: "",
		context: [
			reference && `Reference: ${reference}.`,
			mandate && renderMandate(mandate),
			plan
				.map(
					(item) =>
						`- ${item.id} (${item.stage}): ${item.goal}; nodes: ${item.nodes.join(", ") || "none"}; dependencies: ${item.deps.join(", ") || "none"}`,
				)
				.join("\n") || "No plan items.",
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}
function investigationText(q: Queue, f: Finding) {
	return (f.intake.work === null ? investigateProject : investigateInput)({
		id: String(f.id),
		finding: filingText(f),
		direction: q.direction ? `\n\nOwner direction:\n${q.direction}` : "",
		context: q.context,
		queue:
			q.entries
				.filter((other) => other !== f)
				.map(
					(other) =>
						`- #${other.id} (${[other.status, other.investigation?.classification, other.investigation?.cause].filter(Boolean).join(" / ")}): ${other.intake.text}`,
				)
				.join("\n") || "None.",
		patterns:
			q.patterns
				.map((p) => `- ${p.name} (${p.status}, finding #${p.finding})`)
				.join("\n") || "None.",
	});
}

export function agents(q: Queue): AgentDecl[] {
	if (!q.entries.length) return [];
	const f = pending(q);
	return [
		{
			key: investigator,
			role: "investigator",
			cwd: null,
			paused: q.stall !== null,
			expects:
				f && !q.stall
					? [
							{
								token: turn(f, q),
								tools: ["report_investigation"],
								works: queuedWorks(q),
								situation: "investigate",
								input: () => investigationText(q, f),
							},
						]
					: [],
		},
	];
}

const checkLine = (f: Finding) => `- #${f.id}: ${f.intake.text}`;
export function checks(q: Queue, ids: number[]) {
	return q.entries
		.filter((f) => isOwed(f) && ids.includes(f.id))
		.map(checkLine)
		.join("\n");
}
export function owedChecks(
	q: Queue,
	encoded: number[] = [],
	returning: readonly number[] = [],
) {
	return q.entries
		.filter((f) => isOwed(f) && !encoded.includes(f.id))
		.map((f) => {
			const state =
				f.status === "triage" || returning.includes(f.id)
					? "in triage"
					: beingBuilt(f)
						? "being built"
						: "deferred";
			return `${checkLine(f)} (${state}; rejected ${f.intake.sha})`;
		})
		.join("\n");
}

export function findingSummary(q: Queue, work: WorkId) {
	return q.entries
		.filter((f) => f.intake.work === work)
		.map((f) => `- Finding #${f.id}: ${f.intake.text} (${disposition(f)})`);
}

export function workFor(
	q: Queue,
	e: LaneEvent | KernelEvent,
): Finding["intake"]["work"] {
	if (e.kind === "intake" && "work" in e) return e.work as Intake["work"];
	if (e.kind === "investigated" || e.kind === "begin_investigation")
		return pending(q)?.intake.work ?? null;
	if (e.kind === "answered" && "subject" in e)
		return (
			decisions(q).find((f) => decisionSubject(f) === e.subject)?.intake.work ??
			null
		);
	return null;
}
