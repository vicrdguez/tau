import { arr, obj, oneOf, opt } from "tau/schema";
import { agentKey, subject, token } from "../../kernel/ids.ts";
import {
	type Ask,
	defineLane,
	defineLaneTool,
	type Lane,
	prose,
	type World,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import { toBuild } from "../build/public.ts";
import { fileHolding, resumption } from "../queue/public.ts";
import {
	type Audit,
	auditSchema,
	type Draft,
	reviewedDraft,
	smallDraft,
	text,
	validAudit,
	validSmall,
} from "./draft.ts";
import {
	type Mandate,
	mandateLabels,
	type Reply,
	repliesSchema,
} from "./public.ts";
import {
	active,
	type Changes,
	changesSchema,
	declinedRevision,
	propose,
	type Revision,
	revisionAsk,
	revisionToken,
	revisionTurn,
	sameCauses,
} from "./revision.ts";
import {
	answered,
	approvalNotes,
	binding,
	declineText,
	designerInput,
	notPursued,
	openRound,
	type Round,
	reviewAnswer,
	reviewAsk,
} from "./rounds.ts";
import { designV1 } from "./v1.ts";

export const designTools = [
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "publish_revision",
		description:
			"Propose replacements for the affected labels on the bound Mandate and reply to every owed annotation by number.",
		parameters: obj({ changes: changesSchema, replies: repliesSchema }),
		terminate: true,
		event: (args) => ({ kind: "publish_revision", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "publish_mandate",
		description:
			"Publish the complete labelled Mandate and reply by number to the annotations on the preceding rework answer.",
		parameters: obj({ draft: reviewedDraft, replies: repliesSchema }),
		terminate: true,
		event: (args) => ({ kind: "publish_mandate", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "request_cancel",
		gate: "standing",
		description:
			"When the owner asks to cancel this work, open a confirmation decision. This call does not cancel it.",
		parameters: obj({}),
		terminate: true,
		event: () => ({ kind: "request_cancel" }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "ground",
		gate: "adopt",
		description:
			"Classify the request under its approved reference. Supply a small Mandate for follow, a neutral audit for precedent, or two readings for ambiguous.",
		parameters: obj({
			route: oneOf(["follow", "precedent", "ambiguous"]),
			reference: text,
			mandate: opt(smallDraft),
			audit: opt(auditSchema),
			readings: opt(arr(text, { minItems: 2, maxItems: 2 })),
		}),
		terminate: true,
		event: (args) => ({
			kind: "ground",
			route: args.route,
			reference: args.reference,
			...(args.audit && { audit: args.audit }),
			...(args.mandate && { mandate: args.mandate }),
			...(args.readings && { readings: args.readings }),
		}),
	}),
];

type Seed = {
	route: "follow" | "precedent";
	reference: string | null;
	text: string;
};
type State = {
	phase:
		| "entry"
		| "seeded"
		| "ambiguous"
		| "directed"
		| "resumed"
		| "held"
		| "bound"
		| "drafting"
		| "review"
		| "landed"
		| "closed"
		| "cancelled";
	cancelRequested: boolean;
	cleanup: { build: string[] | null; verify: string[] | null } | null;
	reference: string;
	mandate: Mandate | null;
	audit: Audit | null;
	seed: Seed | null;
	rounds: Round[];
	revisions: Revision[];
	readings: string[];
	direction: string;
	cause: string | null;
	seq: number;
};
const doc = defineState<State>({
	kind: "keel.design",
	scope: "conversation",
	version: 1,
	initial: () => ({
		phase: "entry",
		cancelRequested: false,
		cleanup: null,
		reference: "",
		mandate: null,
		audit: null,
		seed: null,
		rounds: [],
		revisions: [],
		readings: [],
		direction: "",
		cause: null,
		seq: 0,
	}),
});
const ground = prose(import.meta.dirname, "../../prose/documents/ground.md", [
	"reference",
	"first",
	"second",
]);
const directed = prose(
	import.meta.dirname,
	"../../prose/inputs/design/directed.md",
	["direction"],
);
const resumed = prose(
	import.meta.dirname,
	"../../prose/inputs/design/resumed.md",
	["direction"],
);
const seedInputs = {
	follow: prose(
		import.meta.dirname,
		"../../prose/inputs/design/seed-follow.md",
		["finding", "reference", "direction"],
	),
	precedent: prose(
		import.meta.dirname,
		"../../prose/inputs/design/seed-precedent.md",
		["finding", "reference", "direction"],
	),
};
const confirmation = prose(
	import.meta.dirname,
	"../../prose/documents/cancel-work.md",
	["goal"],
);
const cancelNotes = prose(
	import.meta.dirname,
	"../../prose/documents/cancel-annotations.md",
	["annotations"],
);
const cleanupNote = prose(
	import.meta.dirname,
	"../../prose/documents/cancel-cleanup.md",
	["goal", "kept", "work"],
);
const landed = prose(
	import.meta.dirname,
	"../../prose/documents/cancel-landed.md",
	[],
);
const goal = (s: State) =>
	s.mandate?.intent ??
	s.rounds.at(-1)?.draft.intent ??
	s.seed?.text ??
	s.reference;
const groundContext = (s: State) =>
	[s.reference, s.seed?.text].filter(Boolean).join("\n\n");
const references = (s: State) =>
	[
		s.reference,
		...(s.rounds
			.at(-1)
			?.draft.references.map((r) => `${r.label}: ${r.source}`) ?? []),
	].join("\n");
function revisionIndex(s: State) {
	return s.phase === "bound" ? s.revisions.findIndex(active) : -1;
}
function amend(s: State, i: number, change: Partial<Revision>): State {
	return {
		...s,
		revisions: s.revisions.with(i, { ...s.revisions[i]!, ...change }),
	};
}
function nextRevision(s: State) {
	const i = revisionIndex(s);
	return s.revisions[i]?.phase === "queued"
		? amend({ ...s, seq: s.seq + 1, direction: "", cause: null }, i, {
				phase: "drafting",
			})
		: s;
}
function labels(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		!!value.length &&
		new Set(value).size === value.length &&
		value.every((n) => typeof n === "string" && !!n.trim())
	);
}

function cancelledAnnotations(s: State, w: World) {
	const sections: string[] = [];
	const main = s.rounds.at(-1)?.answer;
	if (main?.annotations.length) {
		// The first persisted plan settles every initial approval note together.
		const build =
			main.choice === "approve"
				? (w.view("build") as { plan?: unknown[] } | null)
				: null;
		if (
			main.choice === "rework" ||
			(main.choice === "approve" && !build?.plan?.length)
		)
			sections.push(
				`### Mandate round ${s.rounds.length}\n\n${notPursued(main)}`,
			);
	}
	const revision = s.revisions[revisionIndex(s)];
	const current = revision?.rounds.at(-1)?.answer;
	if (current?.annotations.length)
		sections.push(
			`### Revision round ${revision!.rounds.length}\n\n${notPursued(current)}`,
		);
	return sections.length
		? [
				{
					agent: null,
					text: cancelNotes({ annotations: sections.join("\n\n") }),
				},
			]
		: [];
}

function draftTurn(s: State) {
	return {
		token: token("draft", s.seq),
		tools: ["publish_mandate"],
		situation: "shape",
		input: () =>
			designerInput(s.audit!, groundContext(s), s.rounds, s.direction),
	};
}

export const design: Lane<State> = {
	name: "design",
	state: doc,
	view: (s) => ({ mandate: s.mandate, reference: s.reference }),
	effects: () => [],
	reduce(s, e, w) {
		switch (e.kind) {
			case "request_cancel":
				if (s.phase === "landed") return { reject: landed({}).trim() };
				if (
					s.phase === "entry" ||
					s.phase === "closed" ||
					s.phase === "cancelled"
				)
					return { reject: "There is no open work to cancel." };
				return { state: { ...s, cancelRequested: true } };
			case "cleanup_finished": {
				if (
					!s.cleanup ||
					(e.lane !== "build" && e.lane !== "verify") ||
					s.cleanup[e.lane] !== null
				)
					return { state: s };
				const cleanup = { ...s.cleanup, [e.lane]: e.kept as string[] };
				if (!cleanup.build || !cleanup.verify)
					return { state: { ...s, cleanup } };
				const kept = [...cleanup.build, ...cleanup.verify];
				return {
					state: { ...s, cleanup: null },
					notes: [
						{
							agent: null,
							text: cleanupNote({
								work: String(w.work),
								goal: goal(s),
								kept: kept.length ? kept.join("\n") : "Nothing kept.",
							}),
						},
					],
				};
			}
			case "queue_seed": {
				if (s.phase !== "entry")
					return { reject: "This work already has a Ground turn." };
				const { route } = e;
				const text = typeof e.text === "string" ? e.text.trim() : "";
				const reference =
					typeof e.reference === "string" ? e.reference.trim() : null;
				if (
					!text ||
					(route !== "precedent" && (route !== "follow" || !reference))
				)
					return {
						reject:
							"Seed a precedent design or provide the approved reference for follow work.",
					};
				return {
					state: {
						...s,
						phase: "seeded",
						seed: { route, text, reference },
						seq: s.seq + 1,
					},
				};
			}
			case "revise_mandate": {
				if (s.phase !== "bound") return { state: s };
				const { causes, nodes } = e;
				const text = typeof e.text === "string" ? e.text.trim() : "";
				if (
					!text ||
					!labels(causes) ||
					!labels(nodes) ||
					nodes.some((n) => !mandateLabels(s.mandate!).includes(n))
				)
					return {
						reject:
							"A Mandate revision needs finding causes, evidence and affected binding labels.",
					};
				if (s.revisions.some((r) => r.causes.some((c) => causes.includes(c))))
					return { state: s };
				return {
					state: nextRevision({
						...s,
						revisions: [
							...s.revisions,
							{ phase: "queued", causes, nodes, text, rounds: [] },
						],
					}),
				};
			}
			case "publish_revision": {
				const i = revisionIndex(s);
				const r = s.revisions[i];
				if (r?.phase !== "drafting")
					return { reject: "There is no open Mandate revision turn." };
				const proposed = propose(
					s.mandate!,
					r,
					e.changes as Changes,
					e.replies as Reply[],
				);
				if ("reject" in proposed) return proposed;
				return {
					state: amend({ ...s, direction: "" }, i, {
						phase: "review",
						rounds: [...r.rounds, proposed.round],
					}),
				};
			}
			case "revision_activated": {
				const i = revisionIndex(s);
				const r = s.revisions[i];
				if (
					r?.phase !== "approved" ||
					!labels(e.causes) ||
					!sameCauses(r.causes, e.causes)
				)
					return { state: s };
				const round = r.rounds.at(-1)!;
				const mandate = {
					...round.mandate,
					approvalNotes: approvalNotes(round.answer!),
				};
				return {
					state: nextRevision(
						amend({ ...s, mandate }, i, { phase: "applied" }),
					),
				};
			}
			case "publish_mandate": {
				if (s.phase !== "drafting" || !s.audit)
					return { reject: "There is no open Mandate draft turn." };
				const result = openRound(
					s.audit,
					s.rounds,
					e.draft as Draft,
					e.replies as Reply[],
				);
				if ("reject" in result) return result;
				return {
					state: {
						...s,
						rounds: [...s.rounds, result.round],
						phase: "review",
						direction: "",
					},
				};
			}
			case "ground": {
				if (!["entry", "seeded", "directed", "resumed"].includes(s.phase))
					return { reject: "Ground has no open turn." };
				const reference = String(e.reference ?? "").trim();
				if (!reference)
					return {
						reject: "Name the approved reference, new decision or ambiguity.",
					};
				if (
					s.seed &&
					(e.route !== s.seed.route ||
						(s.seed.reference && reference !== s.seed.reference))
				)
					return { reject: "Keep the queue seed's route and reference." };
				switch (e.route) {
					case "follow": {
						const proposed = e.mandate as Draft | undefined;
						if (!proposed || !validSmall(proposed) || e.readings || e.audit)
							return {
								reject:
									"Give distinct rule labels and check IDs; intent is reserved. Each rule needs a probe and each proof a timed command.",
							};
						const mandate = {
							encodeRequired: false,
							considerations: null,
							delegated: [],
							approvalNotes: [],
							intent: proposed.intent,
							nodes: proposed.nodes,
							checks: proposed.checks,
						};
						return {
							state: {
								...s,
								phase: "bound",
								mandate,
								reference,
								direction: "",
							},
							send: [toBuild(w.work!, { kind: "bound", mandate })],
						};
					}
					case "precedent": {
						const audit = e.audit as Audit | undefined;
						if (e.mandate || e.readings || !audit || !validAudit(audit))
							return {
								reject:
									"Report what exists and label each Ground gap or contradiction once.",
							};
						return {
							state: {
								...s,
								phase: "drafting",
								reference,
								audit,
								seq: s.seq + 1,
							},
						};
					}
					case "ambiguous": {
						const readings = e.readings as string[] | undefined;
						if (
							e.mandate ||
							e.audit ||
							!readings ||
							readings.length !== 2 ||
							readings.some((x) => !x.trim()) ||
							readings[0]!.trim() === readings[1]!.trim()
						)
							return {
								reject: "Give two distinct readings with different outcomes.",
							};
						return {
							state: {
								...s,
								phase: "ambiguous",
								reference,
								readings,
								seq: s.seq + 1,
							},
						};
					}
					default:
						return { reject: "Unknown Ground route." };
				}
			}
			case "resume": {
				const i = revisionIndex(s);
				const revisionHeld = s.revisions[i]?.phase === "held";
				if ((!revisionHeld && s.phase !== "held") || s.cause !== e.cause)
					return { reject: "No such Design hold." };
				const state = {
					...s,
					seq: s.seq + 1,
					cause: null,
					direction: [e.evidence, e.direction].filter(Boolean).join("\n"),
				};
				return {
					state: revisionHeld
						? amend(state, i, { phase: "drafting" })
						: {
								...state,
								phase: s.audit ? "drafting" : s.seed ? "seeded" : "resumed",
							},
				};
			}
			case "landed":
				return s.phase === "bound"
					? { state: { ...s, phase: "landed", cancelRequested: false } }
					: { state: s };
			case "cancel":
				if (
					s.phase === "cancelled" ||
					s.phase === "landed" ||
					s.phase === "closed"
				)
					return { state: s };
				return {
					state: {
						...s,
						phase: "cancelled",
						cause: null,
						direction: "",
						cancelRequested: false,
						cleanup: { build: null, verify: null },
					},
					notes: cancelledAnnotations(s, w),
				};
			case "closed":
				return {
					state: {
						...s,
						phase: "closed",
						direction: "",
						cancelRequested: false,
					},
				};
			default:
				return { reject: "Unknown Design event: " + e.kind };
		}
	},
	onFact(s, e, w) {
		if (e.kind === "answered") {
			if (s.cancelRequested && e.subject === subject("cancel")) {
				return {
					state: { ...s, cancelRequested: false },
					send:
						e.choice === "cancel"
							? [
									{
										lane: "queue",
										work: null,
										event: { kind: "cancel_work", work: w.work! },
									},
								]
							: [],
				};
			}
			const index = revisionIndex(s);
			const revision = s.revisions[index];
			if (revision?.phase === "review") {
				const ask = revisionAsk(s.mandate!, revision, index);
				if (ask.subject !== e.subject || !ask.choices.includes(e.choice))
					return { state: s };
				const answer = reviewAnswer(e, ask.basis);
				const round = { ...revision.rounds.at(-1)!, answer };
				const state = amend(s, index, {
					rounds: [...revision.rounds.slice(0, -1), round],
				});
				switch (e.choice) {
					case "rework":
						return {
							state: amend({ ...state, seq: s.seq + 1 }, index, {
								phase: "drafting",
							}),
						};
					case "decline":
						return {
							state: nextRevision(amend(state, index, { phase: "declined" })),
							send: [
								{
									lane: "queue",
									work: null,
									event: {
										kind: "revision_declined",
										work: w.work!,
										causes: revision.causes,
									},
								},
							],
							notes: [{ agent: null, text: declinedRevision(answer) }],
						};
					case "approve":
						return {
							state: amend(state, index, { phase: "approved" }),
							send: [
								toBuild(w.work!, {
									kind: "propose_revision",
									mandate: {
										...round.mandate,
										approvalNotes: approvalNotes(answer),
									},
									causes: revision.causes,
									nodes: round.nodes,
									text: revision.text,
								}),
							],
						};
				}
			}
			if (s.phase === "review") {
				const outcome = answered(s.audit!, groundContext(s), s.rounds, e);
				if (!outcome) return { state: s };
				const next = { ...s, ...outcome };
				switch (outcome.phase) {
					case "bound": {
						const mandate = binding(s.audit!, outcome.rounds);
						return {
							state: { ...next, mandate },
							send: [toBuild(w.work!, { kind: "bound", mandate })],
						};
					}
					case "closed":
						return {
							state: { ...next, cancelRequested: false },
							notes: [{ agent: null, text: declineText(outcome.rounds) }],
						};
					case "drafting":
						return { state: { ...next, seq: s.seq + 1 } };
				}
			}
			if (s.phase !== "ambiguous" || e.subject !== subject("ground/" + s.seq))
				return { state: s };
			if (e.choice === "decline")
				return { state: { ...s, phase: "closed", cancelRequested: false } };
			if (e.choice !== "first" && e.choice !== "second") return { state: s };
			const direction = [
				s.readings[e.choice === "first" ? 0 : 1],
				...e.annotations.map((n) => n.n + ". " + n.text),
			].join("\n");
			return {
				state: { ...s, phase: "directed", direction, seq: s.seq + 1 },
				send: [
					{
						lane: "verify",
						work: w.work,
						event: { kind: "ambiguity_answer", direction },
					},
				],
			};
		}
		const index = revisionIndex(s);
		const revising = s.revisions[index]?.phase === "drafting";
		const stage = revising
			? "revision"
			: s.phase === "drafting"
				? "draft"
				: "ground";
		if (
			e.kind === "agent_stalled" &&
			(revising ||
				s.phase === "directed" ||
				s.phase === "resumed" ||
				s.phase === "seeded" ||
				s.phase === "drafting") &&
			e.agent === agentKey("designer") &&
			e.tokens.includes(
				stage === "revision" ? revisionToken(s.seq) : token(stage, s.seq),
			)
		) {
			const cause = `${stage}/${s.seq}`;
			const state = { ...s, direction: "", cause };
			return {
				state: revising
					? amend(state, index, { phase: "held" })
					: { ...state, phase: "held" },
				send: [
					fileHolding({
						work: w.work!,
						lane: "design",
						item: null,
						cause,
						goal: goal(s),
						evidence: [e.cause, e.lastWords].join(": "),
						resume: resumption.stalled({ agent: "the designer" }).trim(),
					}),
				],
			};
		}
		return { state: s };
	},
	asks(s) {
		const result: Ask[] = [];
		const index = revisionIndex(s);
		const revision = s.revisions[index];
		if (revision?.phase === "review")
			result.push(revisionAsk(s.mandate!, revision, index));
		if (s.phase === "review") {
			const ask = reviewAsk(s.audit!, groundContext(s), s.rounds);
			if (ask) result.push(ask);
		}
		if (s.phase === "ambiguous") {
			const basis = ground({
				reference: s.reference,
				first: s.readings[0]!,
				second: s.readings[1]!,
			});
			result.push({
				subject: subject("ground/" + s.seq),
				title: `Choose a reading: ${s.reference.split("\n", 1)[0]}`,
				basis,
				choices: ["first", "second", "decline"],
			});
		}
		if (s.cancelRequested) {
			const basis = confirmation({ goal: goal(s) });
			result.push({
				subject: subject("cancel"),
				title: `Cancel work "${goal(s).trim().split("\n", 1)[0]}"?`,
				basis,
				choices: ["cancel", "continue"],
			});
		}
		return result;
	},
	agents(s) {
		if (s.phase === "entry") return [];
		const revision = s.revisions[revisionIndex(s)];
		const expects = [];
		if (s.phase === "drafting") expects.push(draftTurn(s));
		if (revision?.phase === "drafting")
			expects.push(
				revisionTurn(s.mandate!, revision, s.seq, references(s), s.direction),
			);
		if (s.phase === "directed" || s.phase === "resumed" || s.phase === "seeded")
			expects.push({
				token: token("ground", s.seq),
				tools: ["ground"],
				input: () =>
					s.seed
						? seedInputs[s.seed.route]({
								finding: s.seed.text,
								reference: s.seed.reference ?? "None established.",
								direction: s.direction,
							})
						: (s.phase === "resumed" ? resumed : directed)({
								direction: s.direction,
							}),
			});
		return [
			{
				key: agentKey("designer"),
				role: "designer",
				cwd: null,
				paused: false,
				expects,
			},
		];
	},
};
export const designLane = defineLane(design, designV1);
