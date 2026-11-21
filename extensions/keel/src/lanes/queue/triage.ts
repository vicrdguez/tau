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
	"work",
	"choices",
	"findings",
	"impact",
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
		i?.classification === "determined" && `Reference: ${i.reference}`,
		i?.classification === "mandate_wrong" &&
			`Nodes under review: ${i.nodes.join(", ")}.`,
		i && `Size: ${i.size}. Recommendation: ${i.recommendation}.`,
	]
		.filter(Boolean)
		.join("\n");
}
const evidence = (findings: readonly Finding[]) =>
	findings.map(reportText).join("\n\n");
const batchSubject = (finding: Finding) => subject(`triage/${finding.batch}`);
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
	!f.intake.edgeCase &&
	(f.intake.blocking || f.investigation?.classification === "mandate_wrong");
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
		...(first.intake.blocking && { cause: cause(first) }),
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
	const precedent = q.patterns.find((p) => p.name === pattern);
	if (precedent?.status === "blessed")
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
	const serialized = JSON.stringify(input);
	const prior = q.entries.findLast(
		(f) => JSON.stringify(f.intake) === serialized,
	);
	if (prior && prior.status !== "deferred")
		return { state: q, reply: `Already filed as finding #${prior.id}.` };
	const f: Finding = {
		id: q.entries.length + 1,
		intake: input,
		basis: null,
		status: "filed",
		investigation: null,
		batch: null,
		disposition: null,
	};
	if (
		precedent?.status === "revoked" &&
		f.intake.work !== null &&
		context(world, f.intake.work).active
	) {
		const text = `Rework this ruling: the owner revoked ${pattern}.\n\n${filingText(f)}`;
		return {
			state: {
				...q,
				entries: [
					...q.entries,
					{
						...f,
						status: "routed",
						disposition: "revoked pattern: defect for rework",
					},
				],
			},
			send: [
				...(input.blocking ? [hold(f, [])] : []),
				plan(f, [f], text, "Current Mandate"),
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

function shareDecision(f: Finding, i: Investigation, other: Finding) {
	if (
		i.classification !== other.investigation?.classification ||
		other.batch === null
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
	const named =
		e.sameAs == null
			? undefined
			: q.entries.find((entry) => entry.id === e.sameAs && entry.id < f.id);
	const linked = named?.investigation?.duplicateOf
		? q.entries.find((entry) => entry.id === named.investigation!.duplicateOf)
		: named;
	if (e.sameAs != null && !linked)
		return {
			reject: "Name an earlier finding with the same cause and decision.",
		};
	const i: Investigation = {
		classification: e.classification,
		nodes: distinct(e.nodes),
		evidence: e.evidence.trim(),
		size: e.size.trim(),
		cause: linked?.investigation?.cause ?? e.cause.trim(),
		recommendation: e.recommendation,
		reference: e.reference?.trim() || linked?.investigation?.reference || null,
		duplicateOf: e.duplicateOf ?? null,
	};
	if (
		!classes.includes(i.classification) ||
		!i.evidence ||
		!i.size ||
		(!i.cause && !["duplicate", "no_action"].includes(i.classification))
	)
		return {
			reject:
				"Name the class, evidence, estimated size and the decision cause or earlier finding.",
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
	if (linked && !shareDecision(f, i, linked))
		return {
			reject:
				"Name a finding with the same decision, authority and destination.",
		};

	const event = { ...f, investigation: i };
	const live = context(world, f.intake.work);
	if (i.classification === "duplicate") {
		const earlier = q.entries.find(
			(entry) => entry.id === i.duplicateOf && entry.id < f.id,
		);
		if (!earlier || linked)
			return { reject: "Name an earlier duplicate instead of a batch." };
		const original = earlier.investigation?.duplicateOf
			? q.entries.find(
					(entry) => entry.id === earlier.investigation!.duplicateOf,
				)!
			: earlier;
		if (
			original.investigation?.classification === "mandate_wrong" &&
			original.intake.work !== f.intake.work
		)
			return { reject: "The original finding concerns a different Mandate." };
		if (original.intake.pattern !== f.intake.pattern)
			return { reject: "The original finding names a different pattern." };
		const state = update(q, f, {
			...event,
			status: "duplicate",
			investigation: { ...i, duplicateOf: original.id },
		});
		if (original.status === "deferred" && original.investigation) {
			const batch = q.entries.filter(
				(entry) =>
					entry.batch === original.batch && entry.status === "deferred",
			);
			const primary = batch[0] ?? original;
			const current = context(world, primary.intake.work);
			return {
				state: {
					...state,
					entries: state.entries.map((entry) =>
						batch.includes(entry)
							? {
									...entry,
									status: "triage",
									batch: f.id,
									basis:
										entry === primary
											? triageBasis(primary, members(state, batch), current)
											: null,
								}
							: entry,
					),
				},
				send:
					current.active &&
					primary.investigation?.classification === "mandate_wrong"
						? batch
								.filter((entry) => !entry.intake.edgeCase)
								.map((entry) => hold(entry, entry.investigation!.nodes))
						: [],
			};
		}
		if (original.status === "triage") return joined(state, original, event);
		return { state, send: releases([event]) };
	}
	if (i.duplicateOf !== null)
		return { reject: "Only a duplicate names an original finding." };
	if (i.classification === "no_action") {
		if (f.intake.blocking || i.nodes.length)
			return {
				reject:
					"No action is for an observation that has no hold and changes no binding node.",
			};
		return {
			state: update(q, f, {
				status: "no_action",
				investigation: i,
				disposition: `no action: ${i.evidence}`,
			}),
		};
	}
	if (i.classification === "defect_in_scope") {
		if (!live.active)
			return {
				reject: "An in-scope defect must go directly to an active build.",
			};
		return {
			state: update(q, f, { status: "routed", investigation: i }),
			send: [plan(f, [event], reportText(event), "Current Mandate")],
		};
	}
	if (i.classification === "mandate_wrong") {
		const labels = live.mandate ? mandateLabels(live.mandate) : [];
		if (!i.nodes.length || i.nodes.some((n) => !labels.includes(n)))
			return { reject: "Name binding nodes of the current Mandate." };
	}
	const send =
		live.active && i.classification === "mandate_wrong" && !f.intake.edgeCase
			? [hold(event, i.nodes)]
			: [];
	if (linked) {
		const state = update(q, f, {
			...event,
			batch: linked.batch,
			status: linked.status,
			disposition: linked.disposition,
		});
		if (linked.status === "triage") return joined(state, linked, event, send);
		if (linked.status === "revision_pending" && live.active)
			return { state, send: [...send, revision([event], reportText(event))] };
		return { state, send: releases([event]) };
	}
	return {
		state: update(q, f, {
			...event,
			status: "triage",
			batch: f.id,
			basis: triageBasis(event, [event], live),
		}),
		send,
	};
}

function joined(
	state: Queue,
	linked: Finding,
	event: Finding,
	send: Message[] = [],
): Accepted<Queue> {
	return {
		state,
		send,
		notes: [
			{
				agent: null,
				text: `New report for ${batchSubject(linked)}. Your answer also covers this finding.\n\n${reportText(event)}`,
			},
		],
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
	const batch = batches(q).find((b) => batchSubject(b[0]!) === fact.subject);
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
	const active = context(world, first.intake.work).active;
	const revising =
		fact.choice === "build" && i.classification === "mandate_wrong" && active;
	const status =
		fact.choice === "drop"
			? "dropped"
			: fact.choice === "defer"
				? "deferred"
				: fact.choice === "bless"
					? "blessed"
					: revising
						? "revision_pending"
						: "routed";
	const pattern = ["bless", "revoke"].includes(fact.choice)
		? first.intake.pattern
		: null;
	const settled = pattern
		? q.entries.filter(
				(f) =>
					f.intake.pattern === pattern &&
					["filed", "triage"].includes(f.status),
			)
		: batch;
	const state: Queue = {
		...q,
		entries: q.entries.map((entry) =>
			settled.includes(entry)
				? {
						...entry,
						status,
						disposition: fact.choice === "revoke" ? "pattern revoked" : null,
					}
				: entry,
		),
		stall: f && settled.includes(f) ? null : q.stall,
		patterns: pattern
			? [
					...q.patterns,
					{
						name: pattern,
						finding: first.id,
						evidence: text,
						status: fact.choice === "bless" ? "blessed" : "revoked",
					},
				]
			: q.patterns,
	};
	if (revising) return { state, send: [revision(related, text)] };

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
			return "Build asks the designer to propose a revision, or starts follow-up design if the build has handed off. Defer releases holds and lets a later duplicate reopen the decision. Drop releases holds and closes the issue.";
		case "unapproved_pattern":
			return "Bless makes this an approved reference. Revoke starts work to make the pattern fail structurally. Defer parks the finding.";
		default:
			return "Build starts new work with design and Mandate review. Defer parks it. Drop closes it.";
	}
}
function triageBasis(
	first: Finding,
	related: Finding[],
	live: ReturnType<typeof context>,
) {
	const i = first.investigation!;
	const nodes =
		i.classification === "mandate_wrong" ? reportedNodes(related) : [];
	const held = live.active
		? live.plan.filter((item) =>
				related.some(
					(f) =>
						!f.intake.edgeCase &&
						((f.intake.blocking && f.intake.item === item.id) ||
							(f.investigation?.classification === "mandate_wrong" &&
								f.investigation.nodes.some((node) =>
									item.nodes.includes(node),
								))),
				),
			)
		: [];
	const waiting = new Set(held.map((i) => i.id));
	for (let count = -1; count !== waiting.size; ) {
		count = waiting.size;
		for (const item of live.plan)
			if (item.deps.some((id) => waiting.has(id))) waiting.add(item.id);
	}
	const list = (items: typeof live.plan) =>
		items.map((i) => i.id).join(", ") || "None.";
	return triageDocument({
		cause: i.cause,
		work: live.mandate?.intent.split("\n", 1)[0] || "the project queue",
		choices:
			i.classification === "mandate_wrong" && !live.active
				? "Build starts follow-up design. This finding does not hold the landing. Defer parks it. Drop closes it."
				: actions(i.classification),
		findings: evidence(related),
		impact: live.mandate
			? [
					`Held items: ${list(held)}`,
					`Waiting on held dependencies: ${list(live.plan.filter((i) => waiting.has(i.id) && !held.includes(i)))}`,
					`Keeps running: ${list(live.plan.filter((i) => !waiting.has(i.id) && !["cleaning", "merged"].includes(i.stage)))}`,
					nodes.length ? renderMandate(live.mandate, nodes) : "",
				]
					.filter(Boolean)
					.join("\n\n")
			: "",
	});
}

export function asks(q: Queue): Ask[] {
	const out: Ask[] = batches(q).map((batch) => {
		const first = batch[0]!;
		const basis = first.basis!;
		return {
			subject: batchSubject(first),
			title: basis.split("\n", 1)[0]!,
			basis,
			choices: choices(first.investigation!.classification),
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
	return investigateInput({
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
								situation: "investigate",
								input: () => investigationText(q, f),
							},
						]
					: [],
		},
	];
}

export function findingSummary(q: Queue, work: WorkId) {
	const disposition = (f: Finding) =>
		f.disposition ??
		(
			{
				filed: "open: awaiting investigation",
				triage: "open: awaiting triage",
				revision_pending: "open: awaiting Mandate revision",
			} as Partial<Record<Finding["status"], string>>
		)[f.status] ??
		f.status;
	return q.entries
		.filter((f) => f.intake.work === work)
		.map((f) => {
			const original = q.entries.find(
				(entry) => entry.id === f.investigation?.duplicateOf,
			);
			const status = disposition(f);
			return `- Finding #${f.id}: ${f.intake.text} (${original && f.status === "duplicate" ? `duplicate of #${original.id}: ${disposition(original)}` : status})`;
		});
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
			batches(q).find((b) => batchSubject(b[0]!) === e.subject)?.[0]?.intake
				.work ?? null
		);
	return null;
}
