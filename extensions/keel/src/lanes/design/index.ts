import { arr, int, obj, oneOf, opt, str } from "tau/schema";
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
import { fileHolding } from "../queue/public.ts";
import { type Mandate, mandateLabels } from "./public.ts";
import { designV1 } from "./v1.ts";

const text = str({ minLength: 1 });
const draft = obj({
	intent: text,
	nodes: arr(obj({ label: text, rule: text, probe: text })),
	checks: arr(
		obj({
			id: text,
			argv: arr(str(), { minItems: 1 }),
			timeoutMs: int({ minimum: 1, maximum: 2147483647 }),
		}),
		{ minItems: 1 },
	),
	protectedPaths: arr(text),
});
export const designTools = [
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
			"Classify the request under its approved reference. Supply a Mandate for follow, or two readings for ambiguous.",
		parameters: obj({
			route: oneOf(["follow", "precedent", "ambiguous"]),
			reference: text,
			mandate: opt(draft),
			readings: opt(arr(text, { minItems: 2, maxItems: 2 })),
		}),
		terminate: true,
		event: (args) => ({
			kind: "ground",
			route: args.route,
			reference: args.reference,
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
		| "precedent"
		| "closed"
		| "cancelled";
	cancelRequested: boolean;
	cleanup: { build: string[] | null; verify: string[] | null } | null;
	reference: string;
	mandate: Mandate | null;
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
const unavailable = prose(
	import.meta.dirname,
	"../../prose/documents/design-unavailable.md",
	["reference"],
);
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
	["goal", "kept"],
);
const goal = (s: State) => s.mandate?.intent ?? s.reference;

function invalid(m: Mandate) {
	const labels = mandateLabels(m);
	return (
		!m.intent.trim() ||
		new Set(labels).size !== labels.length ||
		labels.some((l) => !l.trim() || l !== l.trim()) ||
		m.nodes.some((n) => !n.rule.trim() || !n.probe.trim()) ||
		!m.checks.length ||
		m.checks.some(
			(c) =>
				!c.argv[0]?.trim() ||
				c.argv.some((a) => a.includes("\0")) ||
				!Number.isSafeInteger(c.timeoutMs) ||
				c.timeoutMs <= 0 ||
				c.timeoutMs > 2147483647,
		) ||
		m.protectedPaths.some((p) => !p.trim() || p.includes("\0"))
	);
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
								goal: goal(s),
								kept: kept.length ? kept.join("\n") : "Nothing kept.",
							}),
						},
					],
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
						const proposed = e.mandate as Mandate | undefined;
						if (!proposed || invalid(proposed) || e.readings)
							return {
								reject:
									"Give distinct rule labels and check IDs; intent and protectedPaths are reserved. Each rule needs a probe and each proof a timed command.",
							};
						const mandate = {
							reviewed: false,
							intent: proposed.intent,
							nodes: proposed.nodes,
							checks: proposed.checks,
							protectedPaths: [
								...new Set([...proposed.protectedPaths, ".keel/**"]),
							],
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
						if (e.mandate || e.readings)
							return {
								reject: "Report the decision that sets precedent on its own.",
							};
						const notice = unavailable({ reference });
						return {
							state: { ...s, phase: "precedent", reference },
							notes: [{ agent: null, text: notice }],
							reply: notice,
						};
					}
					case "ambiguous": {
						const readings = e.readings as string[] | undefined;
						if (
							e.mandate ||
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
						phase: "resumed",
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
			(s.phase === "directed" || s.phase === "resumed") &&
			e.agent === agentKey("designer") &&
			e.tokens.includes(token("ground", s.seq))
		) {
			const cause = "ground/" + s.seq;
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
						resume: "Give the designer a new Ground turn with your direction.",
					}),
				],
			};
		}
		return { state: s };
	},
	asks(s) {
		const result: Ask[] = [];
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
							s.phase === "directed" || s.phase === "resumed"
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
