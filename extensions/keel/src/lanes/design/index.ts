import { arr, obj, oneOf, opt } from "tau/schema";
import { agentKey, subject, token } from "../../kernel/ids.ts";
import {
	type Ask,
	type Message,
	defineLane,
	defineLaneTool,
	type Expectation,
	type Lane,
	prose,
	type World,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import { toBuild } from "../build/public.ts";
import { fileHolding, resumption } from "../queue/public.ts";
import {
	type Arena,
	arenaEffect,
	arenaEvidence,
	blockedAsk,
	candidateNames,
	challengeObjections,
	frameSchema,
	graftsSchema,
	retryArena,
	settleArena,
	startArena,
	startCandidates,
	startChallenger,
	synthesisSources,
} from "./arena.ts";
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
	type Experiment,
	experimentEffect,
	experimentEvidence,
	experimentInput,
	experimentRiders,
	experimentTools,
	finishExperiment,
	recordExperiment,
	startExperiment,
} from "./experiment.ts";
import {
	type Mandate,
	mandateLabels,
	type Reply,
	repliesCover,
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
	revisionTurn,
	sameCauses,
} from "./revision.ts";
import {
	approvalNotes,
	auditText,
	binding,
	continuesReview,
	declineText,
	designerInput,
	notPursued,
	owedText,
	type Round,
	reviewAnswer,
	reviewAsk,
	type Synthesis,
	synthesisBody,
	synthesisError,
} from "./rounds.ts";
import { designV1 } from "./v1.ts";

export const designTools = [
	...experimentTools,
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "frame_arena",
		description:
			"Frame one precedent-setting question and the rubric for comparing the candidates.",
		parameters: frameSchema,
		terminate: true,
		event: (args) => ({ kind: "frame_arena", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "answer_challenger",
		description:
			"Give one numbered disposition per challenge objection to put the synthesis to the owner.",
		parameters: obj({ dispositions: repliesSchema }),
		terminate: true,
		event: (args) => ({ kind: "answer_challenger", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "publish_revision",
		description:
			"Propose additions, replacements or removals against the bound Mandate. Reply to every owed annotation by number.",
		parameters: obj({ changes: changesSchema, replies: repliesSchema }),
		terminate: true,
		event: (args) => ({ kind: "publish_revision", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "revision_settled",
		description:
			"Release a cause when an existing bound Mandate node already settles it.",
		parameters: obj({ cause: text, node: text }),
		terminate: true,
		event: (args) => ({ kind: "revision_settled", ...args }),
	}),
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "publish_mandate",
		description:
			"Submit the complete synthesis: a labelled Mandate, its base and graft sources, and numbered replies to the owner's annotations.",
		parameters: obj({
			draft: reviewedDraft,
			base: text,
			grafts: graftsSchema,
			replies: repliesSchema,
		}),
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
type DesignerPhase =
	| "seeded"
	| "directed"
	| "resumed"
	| "framing"
	| "drafting"
	| "answering"
	| "experiment_comparing";
type State = {
	phase:
		| DesignerPhase
		| "entry"
		| "ambiguous"
		| "held"
		| "bound"
		| "dispatching"
		| "experiment_running"
		| "arena_blocked"
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
	arenas: Arena[];
	experiments: Experiment[];
	experimentReturn: "framing" | "drafting" | null;
	proposal: Synthesis | null;
	rounds: Round[];
	revisions: Revision[];
	readings: string[];
	direction: string;
	cause: string | null;
	heldTurn: DesignerPhase | null;
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
		arenas: [],
		experiments: [],
		experimentReturn: null,
		proposal: null,
		rounds: [],
		revisions: [],
		readings: [],
		direction: "",
		cause: null,
		heldTurn: null,
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
const dir = import.meta.dirname + "/../../prose";
const framingInput = prose(dir, "inputs/design/frame-arena.md", [
	"ground",
	"notes",
	"seed",
	"direction",
]);
const answerInput = prose(dir, "inputs/design/answer-challenger.md", [
	"objections",
	"direction",
]);
const challengeText = prose(dir, "documents/arena-challenge.md", [
	"model",
	"round",
	"base",
	"dispositions",
]);
const goal = (s: State) =>
	s.mandate?.intent ??
	s.proposal?.draft.intent ??
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
	const latest = s.revisions.at(-1);
	return s.phase === "bound" && latest && active(latest)
		? s.revisions.length - 1
		: -1;
}
function amend(s: State, i: number, change: Partial<Revision>): State {
	return {
		...s,
		revisions: s.revisions.with(i, { ...s.revisions[i]!, ...change }),
	};
}
function revisionDisposition(
	work: NonNullable<World["work"]>,
	causes: string[],
	disposition: string,
): Message {
	return {
		lane: "queue",
		work: null,
		event: { kind: "revision_disposition", work, causes, disposition },
	};
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
			continuesReview(main.choice) ||
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

const currentArena = (s: State) => s.arenas.at(-1)!;
const setArena = (s: State, arena: Arena): State => ({
	...s,
	arenas: s.arenas.with(-1, arena),
});
const auditedGround = (s: State) => auditText(s.audit!, groundContext(s));
const currentExperiment = (s: State) => s.experiments.at(-1)!;
function newExperiments(s: State) {
	const reviewed = new Set(
		s.rounds.flatMap((r) => r.evidence.map(({ id }) => id)),
	);
	return s.experiments.filter((e) => e.comparison && !reviewed.has(e.id));
}
const comparedGround = (s: State) =>
	[auditedGround(s), ...newExperiments(s).map(experimentEvidence)].join("\n\n");
function attachExperiments(s: State, proposal: Synthesis): string | null {
	const { draft } = proposal;
	const labels = new Set([
		"intent",
		"never",
		"tradeoffs",
		"alternatives",
		...draft.checks.map((c) => c.id),
		...[...draft.nodes, ...draft.seams, ...draft.settlements].map(
			(n) => n.label,
		),
	]);
	const added = newExperiments(s);
	for (const experiment of added) {
		if (!labels.has(experiment.protocol.node))
			return `Include the Mandate node ${experiment.protocol.node} alongside its recorded experiment evidence.`;
		for (const rider of experimentRiders(experiment)) {
			const supplied = draft.riders.find((r) => r.label === rider.label);
			if (
				supplied &&
				(supplied.origin !== rider.origin || supplied.text !== rider.text)
			)
				return `Keep ${rider.label}'s recorded incidental choice or leave it to Keel to add.`;
			if (!supplied) draft.riders.push(rider);
		}
	}
	proposal.evidence = s.experiments.flatMap((experiment) =>
		experiment.comparison && labels.has(experiment.protocol.node)
			? [
					{
						id: experiment.id,
						node: experiment.protocol.node,
						text: experimentEvidence(experiment),
					},
				]
			: [],
	);
	return null;
}

function openReview(
	s: State,
	proposal: Synthesis,
	challenge: number,
	dispositions: Reply[],
): State {
	return {
		...s,
		proposal: null,
		phase: "review",
		direction: "",
		rounds: [
			...s.rounds,
			{
				...proposal,
				arena: s.arenas.length,
				challenge,
				dispositions,
				answer: null,
			},
		],
	};
}
function mandateAsk(s: State, number = s.rounds.length): Ask {
	const rounds = s.rounds.slice(0, number);
	const round = rounds.at(-1)!;
	const challenged = rounds.findIndex((r) => r.arena === round.arena);
	const arena = s.arenas[round.arena - 1]!;
	const objections = challengeObjections(arena, round.challenge);
	const dispositions =
		objections
			.map((o, i) => {
				const reply = round.dispositions.find((reply) => reply.n === i + 1)!;
				return `${i + 1}. ${o}\n\n   ${reply.status}: ${reply.reason}`;
			})
			.join("\n\n") || "No objections.";
	const evidence = [
		synthesisSources(round.base, round.grafts),
		arenaEvidence(arena, round.arena),
		challengeText({
			model: arena.runs[round.challenge - 1]!.jobs[0]!.model,
			round: String(challenged + 1),
			base: rounds[challenged]!.base,
			dispositions,
		}),
	].join("\n\n");
	return reviewAsk(
		s.audit!,
		groundContext(s),
		rounds,
		evidence,
		candidateNames(arena),
	);
}
function arenaSeed(s: State, round: number | null) {
	if (round === null) return "";
	const r = s.rounds[round - 1]!;
	return `## Seed from round ${round}\n\n${mandateAsk(s, round).basis}\n\n### Owner annotations\n\n${owedText(r)}`;
}

function designerTurn(s: State): Expectation | undefined {
	const revision = s.revisions[revisionIndex(s)];
	if (revision?.phase === "drafting")
		return revisionTurn(
			s.mandate!,
			revision,
			s.seq,
			references(s),
			s.direction,
		);
	switch (s.phase) {
		case "framing":
			return {
				token: token("frame", s.seq),
				tools: ["frame_arena", "start_experiment"],
				situation: "shape",
				input: () =>
					framingInput({
						ground: comparedGround(s),
						direction: s.direction,
						notes: owedText(s.rounds.at(-1)),
						seed: arenaSeed(
							s,
							s.rounds.at(-1)?.answer?.choice === "arena"
								? s.rounds.length
								: null,
						),
					}),
			};
		case "drafting":
			return {
				token: token("draft", s.seq),
				tools: ["publish_mandate", "start_experiment"],
				situation: "shape",
				input: () => {
					const arena = currentArena(s);
					const number = s.arenas.length;
					return designerInput(
						s.audit!,
						groundContext(s),
						s.rounds,
						number,
						[
							arenaEvidence(arena, number),
							...newExperiments(s).map(experimentEvidence),
						].join("\n\n"),
						arena.forcedBase
							? `The owner chose ${arena.forcedBase} as the base. Use it.`
							: "Choose the base and explain your choice with the tradeoffs.",
						s.direction,
					);
				},
			};
		case "experiment_comparing":
			return {
				token: token("experiment", s.seq),
				tools: ["record_experiment"],
				situation: "shape",
				input: () =>
					[experimentInput(currentExperiment(s)), s.direction]
						.filter(Boolean)
						.join("\n\n"),
			};
		case "answering":
			return {
				token: token("objections", s.seq),
				tools: ["answer_challenger"],
				situation: "shape",
				input: () => {
					const arena = currentArena(s);
					return answerInput({
						direction: s.direction,
						objections:
							challengeObjections(arena, arena.runs.length)
								.map((o, i) => `${i + 1}. ${o}`)
								.join("\n") || "No objections.",
					});
				},
			};
		case "directed":
		case "resumed":
		case "seeded":
			return {
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
			};
	}
}

export const design: Lane<State> = {
	name: "design",
	state: doc,
	view: (s) => ({
		mandate: s.mandate,
		reference: s.reference,
		revisionSummary: s.revisions
			.flatMap((r, i) => {
				if (r.phase !== "applied") return [];
				return [`- Revision ${i + 1}: ${r.rounds.at(-1)!.nodes.join(", ")}`];
			})
			.join("\n"),
		experimentEvidence: s.rounds.at(-1)?.evidence ?? [],
		decisions: [...s.rounds, ...s.revisions.flatMap((r) => r.rounds)].flatMap(
			(r) => (r.answer ? [r.answer] : []),
		),
	}),
	effects: (s) => {
		if (s.phase === "dispatching")
			return [arenaEffect(currentArena(s), s.arenas.length)];
		if (s.phase === "experiment_running")
			return [experimentEffect(currentExperiment(s))!];
		return [];
	},
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
				if (!text || !labels(causes) || !labels(nodes))
					return {
						reject:
							"A Mandate revision needs finding causes, evidence and reported labels.",
					};
				const fresh = causes.filter(
					(cause) => !s.revisions.some((r) => r.causes.includes(cause)),
				);
				if (!fresh.length) return { state: s };
				const index = revisionIndex(s);
				const open = s.revisions[index];
				if (!open)
					return {
						state: {
							...s,
							seq: s.seq + 1,
							direction: "",
							cause: null,
							revisions: [
								...s.revisions,
								{ phase: "drafting", causes: fresh, nodes, text, rounds: [] },
							],
						},
					};
				return {
					state: amend({ ...s, seq: s.seq + 1 }, index, {
						phase: open.phase === "held" ? "held" : "drafting",
						causes: [...open.causes, ...fresh],
						nodes: [...new Set([...open.nodes, ...nodes])],
						text: [open.text, text].join("\n\n"),
					}),
					send:
						open.phase === "approved"
							? [toBuild(w.work!, { kind: "withdraw_revision" })]
							: [],
				};
			}
			case "revision_settled": {
				const i = revisionIndex(s);
				const r = s.revisions[i];
				const { cause, node } = e;
				if (
					r?.phase !== "drafting" ||
					typeof cause !== "string" ||
					typeof node !== "string" ||
					!r.causes.includes(cause) ||
					!mandateLabels(s.mandate!).includes(node)
				)
					return {
						reject:
							"Name a pending revision cause and a node of the bound Mandate.",
					};
				const remaining = r.causes.filter((c) => c !== cause);
				return {
					state: amend(
						{ ...s, seq: s.seq + 1 },
						i,
						remaining.length ? { causes: remaining } : { phase: "settled" },
					),
					send: [
						toBuild(w.work!, {
							kind: "queue_release",
							cause,
							direction: `The bound Mandate already settles this in ${node}.`,
						}),
						revisionDisposition(w.work!, [cause], `already settled by ${node}`),
					],
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
				const plan =
					(
						w.view("build") as {
							plan?: {
								id: string;
								goal: string;
								nodes?: string[];
								stage: string;
								verified?: boolean;
							}[];
						} | null
					)?.plan ?? [];
				proposed.round.plan =
					plan
						.filter((i) =>
							i.nodes?.some((n) => proposed.round.nodes.includes(n)),
						)
						.map(
							(i) =>
								`- ${i.id}: ${i.goal}${i.verified || ["cleaning", "merged"].includes(i.stage) ? " (record; add a correction)" : " (replan)"}`,
						)
						.join("\n") || "No plan items affected.";
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
					approvalNotes: r.rounds.flatMap((r) =>
						r.answer?.choice === "approve" ? approvalNotes(r.answer) : [],
					),
				};
				return {
					state: amend({ ...s, mandate }, i, { phase: "applied" }),
					send: [
						revisionDisposition(
							w.work!,
							r.causes,
							`revision applied (${round.nodes.join(", ")})`,
						),
					],
				};
			}
			case "start_experiment": {
				if (s.phase !== "framing" && s.phase !== "drafting")
					return { reject: "Start an experiment during framing or synthesis." };
				if (typeof e.decisionRule !== "string" || !e.decisionRule.trim())
					return {
						reject: "Write the decision rule before starting a prototype.",
					};
				const { node, question, decisionRule, controls, axis, variants } = e;
				if (
					typeof node !== "string" ||
					typeof question !== "string" ||
					typeof axis !== "string" ||
					!Array.isArray(controls) ||
					!controls.every((v) => typeof v === "string") ||
					!Array.isArray(variants) ||
					!variants.every((v) => typeof v === "string")
				)
					return {
						reject:
							"Name the Mandate node, observable question, shared controls and variants on one axis.",
					};
				const started = startExperiment(
					s.experiments.length + 1,
					{ node, question, decisionRule, controls, axis, variants },
					w.options,
				);
				if ("reject" in started) return started;
				return {
					state: {
						...s,
						phase: "experiment_running",
						experimentReturn: s.phase,
						experiments: [...s.experiments, started.experiment],
					},
				};
			}
			case "record_experiment": {
				if (s.phase !== "experiment_comparing")
					return { reject: "No completed experiment needs a comparison." };
				const { comparison, winner } = e;
				if (
					typeof comparison !== "string" ||
					(winner !== undefined && typeof winner !== "string")
				)
					return {
						reject:
							"Explain the comparison and name the winning variant, if any.",
					};
				const recorded = recordExperiment(currentExperiment(s), {
					comparison,
					...(winner !== undefined && { winner }),
				});
				if ("reject" in recorded) return recorded;
				return {
					state: {
						...s,
						phase: s.experimentReturn!,
						experimentReturn: null,
						experiments: s.experiments.with(-1, recorded.experiment),
						seq: s.seq + 1,
					},
				};
			}
			case "frame_arena": {
				if (s.phase !== "framing")
					return { reject: "There is no open arena framing turn." };
				if (
					typeof e.question !== "string" ||
					!e.question.trim() ||
					typeof e.rubric !== "string" ||
					!e.rubric.trim()
				)
					return {
						reject:
							"Give one framed question and the rubric every candidate will be scored against.",
					};
				const seed =
					s.rounds.at(-1)?.answer?.choice === "arena" ? s.rounds.length : null;
				const started = startCandidates(
					startArena(
						{ question: e.question.trim(), rubric: e.rubric.trim() },
						seed,
						w,
					),
					comparedGround(s),
					arenaSeed(s, seed),
				);
				return {
					state: {
						...s,
						phase: started.phase,
						arenas: [...s.arenas, started.arena],
						direction: "",
					},
				};
			}
			case "publish_mandate": {
				if (s.phase !== "drafting" || !s.audit)
					return {
						reject:
							"Complete an arena before submitting the Mandate synthesis.",
					};
				const arena = currentArena(s);
				const seats = candidateNames(arena);
				const grafts = e.grafts as Synthesis["grafts"];
				if (
					typeof e.base !== "string" ||
					!seats.includes(e.base) ||
					!Array.isArray(grafts) ||
					grafts.some(
						(g) =>
							!seats.includes(g.seat) || g.seat === e.base || !g.text.trim(),
					)
				)
					return {
						reject:
							"Choose an arena candidate as base and attribute each graft to another candidate from this arena.",
					};
				if (arena.forcedBase !== null && e.base !== arena.forcedBase)
					return {
						reject: `Use ${arena.forcedBase} as the base, as the owner chose.`,
					};
				const proposal: Synthesis = {
					draft: structuredClone(e.draft as Draft),
					replies: e.replies as Reply[],
					base: e.base,
					grafts,
					evidence: [],
				};
				const error =
					attachExperiments(s, proposal) ??
					synthesisError(s.audit, s.rounds, proposal);
				if (error) return { reject: error };
				const previous = s.rounds.at(-1);
				if (previous?.arena === s.arenas.length)
					return {
						state: openReview(
							s,
							proposal,
							previous.challenge,
							previous.dispositions,
						),
					};
				const synthesis =
					synthesisSources(proposal.base, proposal.grafts) +
					"\n\n" +
					synthesisBody(s.audit, groundContext(s), proposal);
				return {
					state: setArena(
						{ ...s, proposal, phase: "dispatching", direction: "" },
						startChallenger(arena, proposal.base, synthesis),
					),
				};
			}
			case "answer_challenger": {
				if (s.phase !== "answering")
					return { reject: "There is no open challenger report to answer." };
				const arena = currentArena(s);
				const challenge = arena.runs.length;
				const dispositions = e.dispositions as Reply[];
				if (
					!Array.isArray(dispositions) ||
					!repliesCover(
						challengeObjections(arena, challenge).length,
						dispositions,
					)
				)
					return {
						reject:
							"Give one disposition and a reason for each numbered objection.",
					};
				return { state: openReview(s, s.proposal!, challenge, dispositions) };
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
								phase: "framing",
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
								phase: s.heldTurn!,
								heldTurn: null,
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
		if (e.kind === "effect_done" || e.kind === "effect_failed") {
			if (s.phase === "experiment_running") {
				const experiment = finishExperiment(currentExperiment(s), e);
				return experiment
					? {
							state: {
								...s,
								phase: "experiment_comparing",
								experiments: s.experiments.with(-1, experiment),
								seq: s.seq + 1,
							},
						}
					: { state: s };
			}
			if (
				s.phase !== "dispatching" ||
				e.key !== arenaEffect(currentArena(s), s.arenas.length).key
			)
				return { state: s };
			const { arena, phase } = settleArena(currentArena(s), e);
			return { state: setArena({ ...s, phase, seq: s.seq + 1 }, arena) };
		}
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
							state: amend(state, index, { phase: "declined" }),
							send: [
								...revision.causes.map((cause) =>
									toBuild(w.work!, { kind: "queue_release", cause }),
								),
								revisionDisposition(
									w.work!,
									revision.causes,
									"revision declined",
								),
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
										approvalNotes: [
											...revision.rounds.flatMap((r) =>
												r.answer?.choice === "approve"
													? approvalNotes(r.answer)
													: [],
											),
											...approvalNotes(answer),
										],
									},
									causes: revision.causes,
									nodes: round.nodes,
									text: revision.text,
								}),
							],
						};
				}
			}
			if (s.phase === "arena_blocked") {
				const current = currentArena(s);
				const ask = blockedAsk(current, s.seq);
				if (ask.subject !== e.subject || !ask.choices.includes(e.choice))
					return { state: s };
				if (e.choice === "decline")
					return {
						state: { ...s, phase: "closed", cancelRequested: false },
						notes: cancelledAnnotations(s, w),
					};
				const { arena, phase } = retryArena(
					current,
					comparedGround(s),
					arenaSeed(s, current.seedRound),
					w,
				);
				return { state: setArena({ ...s, phase, seq: s.seq + 1 }, arena) };
			}
			if (s.phase === "review") {
				const ask = mandateAsk(s);
				if (ask.subject !== e.subject || !ask.choices.includes(e.choice))
					return { state: s };
				const rounds = s.rounds.with(-1, {
					...s.rounds.at(-1)!,
					answer: reviewAnswer(e, ask.basis),
				});
				const next = { ...s, rounds, seq: s.seq + 1 };
				switch (e.choice) {
					case "approve": {
						const mandate = binding(s.audit!, rounds);
						return {
							state: { ...next, phase: "bound", mandate },
							send: [toBuild(w.work!, { kind: "bound", mandate })],
						};
					}
					case "decline":
						return {
							state: { ...next, phase: "closed", cancelRequested: false },
							notes: [{ agent: null, text: declineText(rounds) }],
						};
					case "arena":
					case "arena_fresh":
						return { state: { ...next, phase: "framing" } };
					case "rework":
						return { state: { ...next, phase: "drafting" } };
					default:
						return {
							state: setArena(
								{ ...next, phase: "drafting" },
								{
									...currentArena(s),
									forcedBase: e.choice.slice("base:".length),
								},
							),
						};
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
		const turn = designerTurn(s);
		if (
			e.kind === "agent_stalled" &&
			turn &&
			e.agent === agentKey("designer") &&
			e.tokens.includes(turn.token)
		) {
			const cause = turn.token.replace("@", "/");
			const state = { ...s, direction: "", cause };
			return {
				state: revising
					? amend(state, index, { phase: "held" })
					: {
							...state,
							phase: "held",
							heldTurn:
								s.phase === "directed" ? "resumed" : (s.phase as DesignerPhase),
						},
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
		if (s.phase === "review") result.push(mandateAsk(s));
		if (s.phase === "arena_blocked")
			result.push(blockedAsk(currentArena(s), s.seq));
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
		const turn = designerTurn(s);
		return [
			{
				key: agentKey("designer"),
				role: "designer",
				cwd: null,
				paused: false,
				expects: turn ? [turn] : [],
			},
		];
	},
};
export const designLane = defineLane(design, designV1);
