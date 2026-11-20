import { arr, obj, oneOf, opt } from "tau/schema";
import { agentKey, subject, token } from "../../kernel/ids.ts";
import {
	type Ask,
	defineLane,
	defineLaneTool,
	type Lane,
	prose,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import { toBuild } from "../build/public.ts";
import { fileHolding, resumption } from "../queue/public.ts";
import {
	type Audit,
	auditSchema,
	type Draft,
	paths,
	reviewedDraft,
	smallDraft,
	text,
	validAudit,
	validSmall,
} from "./draft.ts";
import { type Mandate, type Reply, repliesSchema } from "./public.ts";
import {
	answered,
	binding,
	declineText,
	designerInput,
	openRound,
	type Round,
	reviewAsks,
} from "./rounds.ts";
import { designV1 } from "./v1.ts";

export const designTools = [
	defineLaneTool({
		lane: "design",
		roles: ["designer"],
		name: "publish_mandate",
		description:
			"Publish the complete labelled Mandate and reply by number to the annotations on the preceding rework or design answer.",
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

type State = {
	phase:
		| "entry"
		| "ambiguous"
		| "directed"
		| "resumed"
		| "held"
		| "bound"
		| "drafting"
		| "review"
		| "closed"
		| "cancelled";
	cancelRequested: boolean;
	cleanup: { build: string[] | null; verify: string[] | null } | null;
	reference: string;
	mandate: Mandate | null;
	audit: Audit | null;
	rounds: Round[];
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
		rounds: [],
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
const confirmation = prose(
	import.meta.dirname,
	"../../prose/documents/cancel-work.md",
	["goal"],
);
const cleanupNote = prose(
	import.meta.dirname,
	"../../prose/documents/cancel-cleanup.md",
	["goal", "kept", "work"],
);
const goal = (s: State) => s.mandate?.intent ?? s.reference;

function draftTurn(s: State) {
	return {
		token: token("draft", s.seq),
		tools: ["publish_mandate"],
		situation: "shape",
		input: () => designerInput(s.audit!, s.reference, s.rounds, s.direction),
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
				if (!["entry", "directed", "resumed"].includes(s.phase))
					return { reject: "Ground has no open turn." };
				const reference = String(e.reference ?? "").trim();
				if (!reference)
					return {
						reject: "Name the approved reference, new decision or ambiguity.",
					};
				switch (e.route) {
					case "follow": {
						const proposed = e.mandate as Draft | undefined;
						if (!proposed || !validSmall(proposed) || e.readings || e.audit)
							return {
								reject:
									"Give distinct rule labels and check IDs; intent and protectedPaths are reserved. Each rule needs a probe and each proof a timed command.",
							};
						const mandate = {
							reviewed: false,
							encodeRequired: false,
							delegated: [],
							approvalNotes: [],
							intent: proposed.intent,
							nodes: proposed.nodes,
							checks: proposed.checks,
							protectedPaths: paths(proposed),
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
				if (s.phase !== "held" || s.cause !== e.cause)
					return { reject: "No such Ground hold." };
				return {
					state: {
						...s,
						phase: s.audit ? "drafting" : "resumed",
						seq: s.seq + 1,
						cause: null,
						direction: [e.evidence, e.direction].filter(Boolean).join("\n"),
					},
				};
			}
			case "cancel":
				return s.phase === "cancelled"
					? { state: s }
					: {
							state: {
								...s,
								phase: "cancelled",
								cause: null,
								direction: "",
								cancelRequested: false,
								cleanup: { build: null, verify: null },
							},
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
			if (s.phase === "review") {
				const outcome = answered(s.rounds, e);
				if (!outcome) return { state: s };
				const next = { ...s, ...outcome };
				switch (outcome.phase) {
					case "bound": {
						const mandate = binding(s.audit!, s.reference, outcome.rounds);
						return {
							state: { ...next, mandate },
							send: [toBuild(w.work!, { kind: "bound", mandate })],
						};
					}
					case "closed":
						return {
							state: { ...next, cancelRequested: false },
							notes: [
								{ agent: null, text: declineText(outcome.rounds.at(-1)!) },
							],
						};
					case "drafting":
						return { state: { ...next, seq: s.seq + 1 } };
					default:
						return { state: next };
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
			return { state: { ...s, phase: "directed", direction, seq: s.seq + 1 } };
		}
		if (
			e.kind === "agent_stalled" &&
			(s.phase === "directed" ||
				s.phase === "resumed" ||
				s.phase === "drafting") &&
			e.agent === agentKey("designer") &&
			e.tokens.includes(token(s.audit ? "draft" : "ground", s.seq))
		) {
			const cause = (s.audit ? "draft/" : "ground/") + s.seq;
			return {
				state: { ...s, phase: "held", direction: "", cause },
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
		const result: Ask[] =
			s.phase === "review" ? reviewAsks(s.audit!, s.reference, s.rounds) : [];
		if (s.phase === "ambiguous") {
			const basis = ground({
				reference: s.reference,
				first: s.readings[0]!,
				second: s.readings[1]!,
			});
			result.push({
				subject: subject("ground/" + s.seq),
				title: basis.split("\n", 1)[0]!,
				basis,
				choices: ["first", "second", "decline"],
			});
		}
		if (s.cancelRequested) {
			const basis = confirmation({ goal: goal(s) });
			result.push({
				subject: subject("cancel"),
				title: basis.split("\n", 1)[0]!,
				basis,
				choices: ["cancel", "continue"],
			});
		}
		return result;
	},
	agents: (s) =>
		s.phase === "entry"
			? []
			: [
					{
						key: agentKey("designer"),
						role: "designer",
						cwd: null,
						paused: false,
						expects:
							s.phase === "drafting"
								? [draftTurn(s)]
								: s.phase === "directed" || s.phase === "resumed"
									? [
											{
												token: token("ground", s.seq),
												tools: ["ground"],
												input: () =>
													(s.phase === "resumed" ? resumed : directed)({
														direction: s.direction,
													}),
											},
										]
									: [],
					},
				],
};
export const designLane = defineLane(design, designV1);
