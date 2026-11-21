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
import type { Intake } from "./public.ts";
import {
	batches,
	cause,
	choices,
	classes,
	context,
	duplicates,
	type Finding,
	type Investigated,
	type Investigation,
	pending,
	type Queue,
	update,
} from "./state.ts";

const documents = `${import.meta.dirname}/../../prose/documents`;
const investigateInput = prose(
	import.meta.dirname,
	"../../prose/inputs/queue/investigate.md",
	["id", "finding", "context", "queue", "patterns", "direction"],
);
const triageDocument = prose(documents, "triage.md", [
	"cause",
	"choices",
	"findings",
]);
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
		work,
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
		`Source: ${[source, work === null ? "project" : `work ${work}`, item].filter(Boolean).join(" / ")}. Revision: ${sha ?? "not available"}.`,
		nodes.length && `Reported nodes: ${nodes.join(", ")}.`,
		report && `Report: ${report}`,
		edgeCase &&
			`Failure mode: ${edgeCase.failure}\nLikelihood: ${edgeCase.likelihood}\nComplexity cost: ${edgeCase.cost}`,
		pattern && `Pattern: ${pattern}`,
		blocking && `The filer could not continue item ${item}.`,
	]
		.filter(Boolean)
		.join("\n");
}
function reportText(f: Finding) {
	const i = f.investigation;
	return [
		filingText(f),
		i && `Investigation: ${i.evidence}`,
		i?.duplicateOf && `Duplicate of #${i.duplicateOf}.`,
		i?.reference && `Reference: ${i.reference}`,
		i?.classification === "mandate_wrong" &&
			`Held nodes: ${i.nodes.join(", ")}.`,
		i && `Size: ${i.size}. Recommendation: ${i.recommendation}.`,
	]
		.filter(Boolean)
		.join("\n");
}
const evidence = (findings: readonly Finding[]) =>
	findings.map(reportText).join("\n\n");
const batchSubject = (findings: readonly Finding[]) =>
	subject(`triage/${findings.map((f) => f.id).join("-")}`);
const members = (q: Queue, batch: Finding[]) =>
	[...batch, ...duplicates(q, batch)].sort((a, b) => a.id - b.id);

function hold(f: Finding, nodes: string[]): Message {
	return toBuild(f.intake.work!, {
		kind: "queue_hold",
		cause: cause(f),
		item: nodes.length ? null : f.intake.item,
		nodes,
		evidence: reportText(f),
	});
}
const hasHold = (f: Finding) =>
	f.intake.blocking || f.investigation?.classification === "mandate_wrong";
function releases(findings: readonly Finding[], direction?: string): Message[] {
	return findings.flatMap((f) =>
		f.intake.work !== null && hasHold(f)
			? [
					toBuild(f.intake.work, {
						kind: "queue_release",
						cause: cause(f),
						...(direction && { direction }),
					}),
				]
			: [],
	);
}
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
	reference: string,
): Message {
	return toBuild(first.intake.work!, {
		kind: "plan_finding",
		text,
		reference,
		nodes: reportedNodes(findings),
	});
}
function seed(
	route: "follow" | "precedent",
	text: string,
	reference: string | null,
): Message {
	return {
		lane: "design",
		work: "new",
		event: { kind: "queue_seed", route, text, reference },
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
	if (pattern && q.patterns.some((p) => p.name === pattern))
		return {
			state: q,
			reply: `Approved reference: ${pattern}. No finding filed.`,
		};
	const input: Intake = {
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
	};
	const prior = q.entries.find(
		(f) => JSON.stringify(f.intake) === JSON.stringify(input),
	);
	if (prior)
		return { state: q, reply: `Already filed as finding #${prior.id}.` };
	const f: Finding = {
		id: q.entries.length + 1,
		intake: input,
		context: context(world, e.work),
		status: "filed",
		investigation: null,
		batch: null,
		disposition: null,
	};
	return {
		state: { ...q, entries: [...q.entries, f] },
		send: input.blocking ? [hold(f, [])] : [],
		reply: `Filed finding #${f.id}.`,
	};
}

function sameDecision(f: Finding, i: Investigation, other: Finding) {
	if (
		i.classification !== other.investigation?.classification ||
		i.cause !== other.investigation.cause
	)
		return false;
	switch (i.classification) {
		case "mandate_wrong":
			return other.intake.work === f.intake.work;
		case "determined":
			return (
				other.intake.work === f.intake.work &&
				other.investigation.reference === i.reference
			);
		case "unapproved_pattern":
			return other.intake.pattern === f.intake.pattern;
		case "sets_precedent":
			return true;
		default:
			return false;
	}
}

export function classify(
	q: Queue,
	e: Investigated,
	world: World,
): Reduction<Queue> {
	const f = pending(q);
	if (!f || q.stall || f.id !== e.finding)
		return { reject: "Report the finding assigned in your current input." };
	if (
		!classes.includes(e.classification) ||
		!e.evidence.trim() ||
		!e.size.trim() ||
		!e.cause.trim()
	)
		return {
			reject:
				"Name the class, evidence, estimated size and the cause that takes one decision.",
		};
	const i: Investigation = {
		classification: e.classification,
		nodes: distinct(e.nodes),
		evidence: e.evidence.trim(),
		size: e.size.trim(),
		cause: e.cause.trim(),
		recommendation: e.recommendation,
		reference: e.reference?.trim() || null,
		duplicateOf: e.duplicateOf ?? null,
	};
	if (!choices(i.classification).some((c) => c === i.recommendation))
		return { reject: "Recommend a choice available for this class." };
	if (i.classification === "determined" && !i.reference)
		return {
			reject: "Name the approved reference that determines this finding.",
		};
	if (
		Boolean(f.intake.pattern) !== (i.classification === "unapproved_pattern") &&
		i.classification !== "duplicate"
	)
		return {
			reject:
				"Use the unapproved pattern class only when the filing names a pattern.",
		};
	const event = { ...f, investigation: i };
	if (i.classification === "duplicate") {
		const earlier = q.entries.find(
			(entry) => entry.id === i.duplicateOf && entry.id < f.id,
		);
		if (!earlier || e.batchWith.length)
			return { reject: "Name an earlier duplicate instead of a batch." };
		const original =
			earlier.investigation?.duplicateOf === null || !earlier.investigation
				? earlier
				: q.entries.find(
						(entry) => entry.id === earlier.investigation?.duplicateOf,
					)!;
		if (
			original.investigation?.classification === "mandate_wrong" &&
			original.intake.work !== f.intake.work
		)
			return { reject: "The original finding concerns a different Mandate." };
		if (original.intake.pattern !== f.intake.pattern)
			return { reject: "The original finding names a different pattern." };
		return {
			state: update(q, f, {
				status: "duplicate",
				investigation: { ...i, duplicateOf: original.id },
			}),
			send: original.status === "triage" ? [] : releases([event]),
		};
	}
	if (i.duplicateOf !== null)
		return { reject: "Only a duplicate names an original finding." };
	const live = context(world, f.intake.work);
	if (i.classification === "defect_in_scope") {
		if (e.batchWith.length || !live.active)
			return {
				reject: "An in-scope defect must go directly to an active build.",
			};
		const text = reportText(event);
		return {
			state: update(q, f, { status: "routed", investigation: i }),
			send: [plan(f, [event], text, "Current Mandate"), ...releases([event])],
		};
	}
	if (i.classification === "mandate_wrong") {
		const labels = live.mandate ? mandateLabels(live.mandate) : [];
		if (
			!live.active ||
			!i.nodes.length ||
			i.nodes.some((n) => !labels.includes(n))
		)
			return {
				reject: "Name binding nodes of the current Mandate in an active build.",
			};
	}
	const groups = new Set<number>();
	for (const id of e.batchWith) {
		const other = q.entries.find((entry) => entry.id === id);
		if (
			!other ||
			other.status !== "triage" ||
			other.batch === null ||
			!sameDecision(f, i, other)
		)
			return {
				reject:
					"Batch only open findings with the same cause, authority and destination.",
			};
		groups.add(other.batch);
	}
	const batch = Math.min(f.id, ...groups);
	return {
		state: {
			...q,
			entries: q.entries.map((entry) =>
				entry === f
					? { ...event, status: "triage", batch }
					: entry.batch !== null &&
							groups.has(entry.batch) &&
							entry.status === "triage"
						? { ...entry, batch }
						: entry,
			),
		},
		send: i.classification === "mandate_wrong" ? [hold(event, i.nodes)] : [],
	};
}

export function cancelWork(q: Queue, work: WorkId): Queue {
	return {
		...q,
		entries: q.entries.map((f) =>
			f.intake.work === work &&
			f.status === "triage" &&
			f.investigation?.classification === "mandate_wrong"
				? { ...f, status: "cancelled" }
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
					status: "dropped",
				}),
				send: releases([f], "The owner cancelled the investigation."),
			};
		return { state: q };
	}
	const batch = batches(q).find(
		(b) => batchSubject(members(q, b)) === fact.subject,
	);
	const first = batch?.[0];
	const i = first?.investigation;
	if (
		!batch ||
		!first ||
		!i ||
		!choices(i.classification).some((choice) => choice === fact.choice)
	)
		return { state: q };
	const related = members(q, batch);
	const annotations = fact.annotations
		.map((a) => `${a.n}. ${a.text}`)
		.join("\n");
	const text = [
		evidence(related),
		annotations && `Owner direction:\n${annotations}`,
	]
		.filter(Boolean)
		.join("\n\n");
	const status =
		fact.choice === "drop"
			? "dropped"
			: fact.choice === "defer"
				? "deferred"
				: fact.choice === "bless"
					? "blessed"
					: "routed";
	const pattern = fact.choice === "bless" ? first.intake.pattern : null;
	const settled = pattern
		? q.entries.filter(
				(f) =>
					f.intake.pattern === pattern &&
					(f.status === "filed" || f.status === "triage"),
			)
		: batch;
	const state: Queue = {
		...q,
		entries: q.entries.map((entry) =>
			settled.includes(entry) ? { ...entry, status } : entry,
		),
		stall: f && settled.includes(f) ? null : q.stall,
		patterns: pattern
			? [...q.patterns, { name: pattern, finding: first.id, evidence: text }]
			: q.patterns,
	};
	if (fact.choice === "build" && i.classification === "mandate_wrong") {
		return {
			state,
			send: [
				{
					lane: "design",
					work: first.intake.work,
					event: {
						kind: "revise_mandate",
						causes: related.filter(hasHold).map(cause),
						nodes: distinct(batch.flatMap((f) => f.investigation?.nodes ?? [])),
						text,
					},
				},
			],
		};
	}
	const send: Message[] = [];
	if (fact.choice === "build") {
		if (i.classification === "determined")
			send.push(
				context(world, first.intake.work).active
					? plan(first, related, text, i.reference!)
					: seed("follow", text, i.reference),
			);
		else send.push(seed("precedent", text, null));
	}
	if (fact.choice === "revoke")
		send.push(
			seed(
				"precedent",
				`Make the pattern ${first.intake.pattern} fail structurally and migrate its callers.\n\n${text}`,
				null,
			),
		);
	return {
		state,
		send: [...send, ...releases(members(q, settled), annotations)],
	};
}

function actions(classification: Investigation["classification"]) {
	switch (classification) {
		case "determined":
			return "Build adds work to the related active build or starts new work under the approved reference. Defer parks it. Drop closes it.";
		case "mandate_wrong":
			return "Build asks this work's designer to propose a revision; affected items stay held. Defer or drop releases these holds without changing the Mandate.";
		case "unapproved_pattern":
			return "Bless makes this an approved reference. Revoke starts work to make the pattern fail structurally. Defer parks the finding.";
		default:
			return "Build starts new work with design and Mandate review. Defer parks it. Drop closes it.";
	}
}
export function asks(q: Queue): Ask[] {
	const out: Ask[] = batches(q).map((batch) => {
		const i = batch[0]!.investigation!;
		const related = members(q, batch);
		const basis = triageDocument({
			cause: i.cause,
			choices: actions(i.classification),
			findings: evidence(related),
		});
		return {
			subject: batchSubject(related),
			title: basis.split("\n", 1)[0]!,
			basis,
			choices: choices(i.classification),
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
		});
	}
	return out;
}
function investigationText(q: Queue, f: Finding) {
	const { mandate, plan, reference } = f.context;
	return investigateInput({
		id: String(f.id),
		finding: filingText(f),
		direction: q.direction ? `Owner direction:\n${q.direction}` : "",
		context: [
			reference && `Reference: ${reference}.`,
			mandate && renderMandate(mandate),
			plan
				.map(
					(item) =>
						`- ${item.id} (${item.stage}): ${item.goal}; nodes: ${item.nodes.join(", ") || "none"}; dependencies: ${item.deps.join(", ") || "none"}`,
				)
				.join("\n") || "No plan items at filing.",
		]
			.filter(Boolean)
			.join("\n\n"),
		queue:
			q.entries
				.filter((other) => other !== f)
				.map(
					(other) => `- #${other.id} (${other.status}): ${other.intake.text}`,
				)
				.join("\n") || "None.",
		patterns:
			q.patterns.map((p) => `- ${p.name} (finding #${p.finding})`).join("\n") ||
			"None.",
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
								situation: "investigate",
								input: () => investigationText(q, f),
							},
						]
					: [],
		},
	];
}

export function workFor(
	q: Queue,
	e: LaneEvent | KernelEvent,
): Finding["intake"]["work"] {
	if (e.kind === "intake" && "work" in e) return e.work as Intake["work"];
	if (e.kind === "investigated") return pending(q)?.intake.work ?? null;
	if (e.kind === "answered" && "subject" in e)
		return (
			batches(q).find((b) => batchSubject(members(q, b)) === e.subject)?.[0]
				?.intake.work ?? null
		);
	return null;
}
