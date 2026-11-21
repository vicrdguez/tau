import { arr, obj, opt } from "tau/schema";
import { subject, token } from "../../kernel/ids.ts";
import { type Ask, type Expectation, prose } from "../../kernel/lane.ts";
import {
	checkSchema,
	type Draft,
	renderSeam,
	ruleSchema,
	seamSchema,
	text,
	validCheck,
	validRule,
	validSeam,
} from "./draft.ts";
import {
	type Mandate,
	type Reply,
	renderMandate,
	repliesCover,
} from "./public.ts";
import { type Answer, annotation } from "./rounds.ts";

export const changesSchema = obj({
	intent: opt(text),
	nodes: opt(arr(ruleSchema)),
	seams: opt(arr(seamSchema)),
	checks: opt(arr(checkSchema)),
	sections: opt(arr(obj({ label: text, body: text }))),
});
export type Changes = Partial<
	Pick<Draft, "intent" | "nodes" | "seams" | "checks">
> & {
	sections?: { label: string; body: string }[];
};
type RevisionRound = {
	mandate: Mandate;
	nodes: string[];
	replies: Reply[];
	answer: Answer | null;
};
export type Revision = {
	phase:
		| "queued"
		| "drafting"
		| "review"
		| "held"
		| "approved"
		| "applied"
		| "declined";
	causes: string[];
	nodes: string[];
	text: string;
	rounds: RevisionRound[];
};
export const active = (r: Revision) =>
	r.phase !== "applied" && r.phase !== "declined";
const owed = (r: RevisionRound | undefined) =>
	r?.answer?.choice === "rework" ? r.answer.annotations : [];
export const revisionToken = (seq: number) => token("revision", seq);

export function propose(
	base: Mandate,
	r: Revision,
	changes: Changes,
	replies: Reply[],
): { round: RevisionRound } | { reject: string } {
	if (!repliesCover(owed(r.rounds.at(-1)).length, replies))
		return { reject: "Reply to every owed number exactly once with a reason." };
	if (!changes || typeof changes !== "object")
		return { reject: "Give the changed Mandate nodes." };
	const {
		intent,
		nodes = [],
		seams = [],
		checks = [],
		sections = [],
	} = changes;
	if (
		(intent !== undefined && !intent.trim()) ||
		!nodes.every(validRule) ||
		!seams.every(validSeam) ||
		!checks.every(validCheck) ||
		sections.some((n) => !n.body.trim())
	)
		return {
			reject:
				"Give complete replacements: rules with probes, usage-first seams and usable timed proofs.",
		};
	const labels = [
		...(intent === undefined ? [] : ["intent"]),
		...nodes.map((n) => n.label),
		...seams.map((n) => n.label),
		...checks.map((c) => c.id),
		...sections.map((n) => n.label),
	];
	if (
		new Set(labels).size !== labels.length ||
		labels.some((l) => !r.nodes.includes(l))
	)
		return {
			reject: "Replace only distinct nodes named in the investigated finding.",
		};
	const prior = new Map(base.nodes.map((n) => [n.label, n]));
	if (
		nodes.some((n) => !("rule" in (prior.get(n.label) ?? {}))) ||
		seams.some((n) => {
			const old = prior.get(n.label);
			return !old || !("section" in old) || old.section !== "Seam";
		}) ||
		checks.some((c) => !base.checks.some((old) => old.id === c.id)) ||
		sections.some((n) => {
			const old = prior.get(n.label);
			return !old || !("section" in old) || old.section === "Seam";
		})
	)
		return { reject: "Use the existing node kind for each replacement." };
	const replaced = new Map<string, Mandate["nodes"][number]>([
		...nodes.map((n) => [n.label, n] as const),
		...seams.map(
			(s) =>
				[
					s.label,
					{ label: s.label, section: "Seam", body: renderSeam(s) },
				] as const,
		),
		...sections.map(
			(n) => [n.label, { ...prior.get(n.label)!, body: n.body }] as const,
		),
	]);
	const mandate = {
		...base,
		intent: intent ?? base.intent,
		nodes: base.nodes.map((n) => replaced.get(n.label) ?? n),
		checks: base.checks.map(
			(c) => checks.find((next) => next.id === c.id) ?? c,
		),
	};
	const changed = labels.filter(
		(l) => renderMandate(base, [l]) !== renderMandate(mandate, [l]),
	);
	if (!changed.length) return { reject: "There is no change to review." };
	return { round: { mandate, nodes: changed, replies, answer: null } };
}

const dir = import.meta.dirname + "/../../prose";
const review = prose(dir, "documents/revision-review.md", [
	"summary",
	"evidence",
	"before",
	"after",
	"replies",
]);
const draft = prose(dir, "inputs/design/propose-revision.md", [
	"evidence",
	"nodes",
	"mandate",
	"references",
	"direction",
]);
const rework = prose(dir, "inputs/design/rework-revision.md", [
	"evidence",
	"nodes",
	"mandate",
	"references",
	"before",
	"after",
	"annotations",
	"direction",
]);
const decline = prose(dir, "documents/revision-declined.md", ["annotations"]);

export function revisionAsk(base: Mandate, r: Revision, index: number): Ask {
	const current = r.rounds.at(-1)!;
	const previous = r.rounds.at(-2);
	const changes = previous
		? [
				...current.nodes.flatMap((l) =>
					!previous.nodes.includes(l)
						? [`${l} new`]
						: renderMandate(current.mandate, [l]) !==
								renderMandate(previous.mandate, [l])
							? [`${l} changed`]
							: [],
				),
				...previous.nodes
					.filter((l) => !current.nodes.includes(l))
					.map((l) => `${l} removed`),
			]
		: [];
	return {
		subject: subject(`revision/${index + 1}/${r.rounds.length}`),
		title: `Review Mandate revision: ${current.nodes.join(", ")}`,
		basis: review({
			summary: previous
				? `Since round ${r.rounds.length - 1}: ${changes.join(", ") || "no nodes changed"}.\n`
				: "",
			evidence: r.text,
			before: renderMandate(base, current.nodes),
			after: renderMandate(current.mandate, current.nodes),
			replies:
				owed(previous)
					.map((a) => {
						const reply = current.replies.find((n) => n.n === a.n)!;
						return `${annotation(a)}\n   ${reply.status}: ${reply.reason}`;
					})
					.join("\n") || "None.",
		}),
		choices: ["approve", "rework", "decline"],
	};
}

export function revisionTurn(
	base: Mandate,
	r: Revision,
	seq: number,
	references: string,
	direction: string,
): Expectation {
	return {
		token: revisionToken(seq),
		tools: ["publish_revision"],
		situation: "shape",
		input: () => {
			const fields = {
				evidence: r.text,
				nodes: r.nodes.join(", "),
				mandate: renderMandate(base),
				references,
				direction,
			};
			const previous = r.rounds.at(-1);
			return previous
				? rework({
						...fields,
						before: renderMandate(base, previous.nodes),
						after: renderMandate(previous.mandate, previous.nodes),
						annotations:
							owed(previous)
								.map((a) => annotation(a))
								.join("\n") || "None.",
					})
				: draft(fields);
		},
	};
}
export const declinedRevision = (a: Answer) =>
	decline({
		annotations:
			a.annotations.map((n) => annotation(n, ": not pursued")).join("\n") ||
			"None.",
	});
export const sameCauses = (causes: string[], reply: string[]) =>
	causes.length === reply.length && causes.every((c) => reply.includes(c));
