import { arr, int, obj, oneOf, opt, str } from "tau/schema";
import { agentKey, subject, token } from "../../kernel/ids.ts";
import {
	defineLane,
	defineLaneTool,
	type KernelEvent,
	type Lane,
	prose,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
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
									"Give a Mandate with distinct labels, a probe for each rule and timed proof commands.",
							};
						const mandate = {
							...proposed,
							protectedPaths: [
								...new Set([...proposed.protectedPaths, ".keel/**"]),
							],
						};
						return {
							state: { ...s, phase: "bound", mandate, reference },
							send: [
								{
									lane: "build",
									work: w.work,
									event: { kind: "bound", mandate },
								},
							],
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
			case "answered": {
				const a = e as Extract<KernelEvent, { kind: "answered" }>;
				if (s.phase !== "ambiguous" || a.subject !== subject("ground/" + s.seq))
					return { reject: "This ambiguity is no longer open." };
				if (a.choice === "decline") return { state: { ...s, phase: "closed" } };
				if (a.choice !== "first" && a.choice !== "second")
					return { reject: "Unknown reading." };
				const direction = [
					s.readings[a.choice === "first" ? 0 : 1],
					...a.annotations.map((n) => n.n + ". " + n.text),
				].join("\n");
				return {
					state: { ...s, phase: "directed", direction, seq: s.seq + 1 },
				};
			}
			case "agent_stalled": {
				if (s.phase !== "directed" && s.phase !== "resumed")
					return { state: s };
				const cause = "ground/" + s.seq;
				return {
					state: { ...s, phase: "held", cause },
					send: [
						{
							lane: "queue",
							work: null,
							event: {
								kind: "file",
								work: w.work,
								lane: "design",
								item: null,
								cause,
								evidence: [e.cause, e.lastWords].join(": "),
							},
						},
					],
				};
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
						direction: [s.direction, e.evidence, e.direction].join("\n"),
					},
				};
			}
			case "cancel":
				return { state: { ...s, phase: "cancelled", cause: null } };
			case "closed":
				return { state: { ...s, phase: "closed" } };
			default:
				return { reject: "Unknown Design event: " + e.kind };
		}
	},
	asks(s) {
		if (s.phase !== "ambiguous") return [];
		const basis = ground({
			reference: s.reference,
			first: s.readings[0]!,
			second: s.readings[1]!,
		});
		return [
			{
				subject: subject(`ground/${s.seq}`),
				title: basis.split("\n", 1)[0]!,
				basis,
				choices: ["first", "second", "decline"],
			},
		];
	},
	agents: (s) =>
		s.phase === "entry" || s.phase === "closed" || s.phase === "cancelled"
			? []
			: [
					{
						key: agentKey("designer"),
						role: "designer",
						cwd: null,
						paused: s.phase === "held",
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
