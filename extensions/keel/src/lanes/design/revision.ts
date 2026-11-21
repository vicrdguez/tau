import { arr, obj, opt } from "tau/schema";
import { subject, token } from "../../kernel/ids.ts";
import { type Ask, type Expectation, prose } from "../../kernel/lane.ts";
import {
	changedFields,
	checkSchema,
	type Draft,
	renderSeam,
	ruleSchema,
	seamFields,
	seamSchema,
	text,
	validCheck,
	validRule,
	validSeam,
} from "./draft.ts";
import {
	type Mandate,
	mandateLabels,
	type Reply,
	renderMandate,
	repliesCover,
} from "./public.ts";
import {
	type Answer,
	annotation,
	notPursued,
	precedingRound,
} from "./rounds.ts";

export const changesSchema = obj({
	intent: opt(text),
	nodes: opt(arr(ruleSchema)),
	seams: opt(arr(seamSchema)),
	checks: opt(arr(checkSchema)),
	sections: opt(arr(obj({ label: text, body: text }))),
	remove: opt(arr(text)),
});
export type Changes = Partial<
	Pick<Draft, "intent" | "nodes" | "seams" | "checks">
> & {
	sections?: { label: string; body: string }[];
	remove?: string[];
};
type RevisionRound = {
	mandate: Mandate;
	nodes: string[];
	replies: Reply[];
	plan: string;
	answer: Answer | null;
};
export type Revision = {
	phase:
		| "drafting"
		| "review"
		| "held"
		| "approved"
		| "applied"
		| "declined"
		| "settled";
	causes: string[];
	nodes: string[];
	text: string;
	rounds: RevisionRound[];
};
export const active = (r: Revision) =>
	r.phase !== "applied" && r.phase !== "declined" && r.phase !== "settled";
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
		remove = [],
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
				"Give complete rules with probes, usage-first seams and usable timed proofs.",
		};
	const prior = new Map(base.nodes.map((n) => [n.label, n]));
	const replaced: Mandate["nodes"] = [
		...nodes,
		...seams.map((s) => ({
			label: s.label,
			section: "Seam",
			body: renderSeam(s),
			seam: s,
		})),
		...sections.map((n) => {
			const old = prior.get(n.label);
			return { ...n, section: old && "section" in old ? old.section : "Note" };
		}),
	];
	const labels = [
		...(intent === undefined ? [] : ["intent"]),
		...replaced.map((n) => n.label),
		...checks.map((c) => c.id),
		...remove,
	];
	if (
		new Set(labels).size !== labels.length ||
		labels.some((l) => !l.trim() || l !== l.trim() || /[\r\n]/.test(l)) ||
		remove.includes("intent") ||
		remove.some((l) => !mandateLabels(base).includes(l)) ||
		[...replaced.map((n) => n.label), ...checks.map((c) => c.id)].includes(
			"intent",
		) ||
		sections.some((n) => {
			const old = prior.get(n.label);
			return old && "section" in old && old.section === "Seam";
		})
	)
		return {
			reject:
				"Use distinct labels and remove only existing nodes other than intent. Give seams with their full contract.",
		};
	const replace = new Set([
		...replaced.map((n) => n.label),
		...checks.map((c) => c.id),
		...remove,
	]);
	const mandate = {
		...base,
		intent: intent ?? base.intent,
		nodes: [
			...base.nodes.flatMap((n) => {
				const replacement = replaced.find((entry) => entry.label === n.label);
				return replacement ? [replacement] : replace.has(n.label) ? [] : [n];
			}),
			...replaced.filter((n) => !prior.has(n.label)),
		],
		checks: [
			...base.checks.flatMap((c) => {
				const replacement = checks.find((entry) => entry.id === c.id);
				return replacement ? [replacement] : replace.has(c.id) ? [] : [c];
			}),
			...checks.filter((c) => !base.checks.some((prior) => prior.id === c.id)),
		],
	};
	if (!mandate.checks.length)
		return { reject: "Keep at least one timed proof." };
	const changed = [
		...new Set([...mandateLabels(base), ...mandateLabels(mandate)]),
	].filter((l) => renderMandate(base, [l]) !== renderMandate(mandate, [l]));
	if (!changed.length) return { reject: "There is no change to review." };
	return {
		round: {
			mandate,
			nodes: changed,
			replies,
			answer: null,
			plan: "No plan items affected.",
		},
	};
}

function mandateFields(m: Mandate, label: string) {
	if (label === "intent") return { intent: m.intent };
	const check = m.checks.find((c) => c.id === label);
	if (check) return { command: check.argv, timeout: check.timeoutMs };
	const n = m.nodes.find((n) => n.label === label)!;
	if ("rule" in n) return { rule: n.rule, "falsifying probe": n.probe };
	return "seam" in n
		? seamFields(n.seam)
		: { section: n.section, text: n.body };
}

const dir = import.meta.dirname + "/../../prose";
const review = prose(dir, "documents/revision-review.md", [
	"summary",
	"evidence",
	"before",
	"after",
	"history",
	"plan",
]);
const draft = prose(dir, "inputs/design/propose-revision.md", [
	"evidence",
	"nodes",
	"causes",
	"mandate",
	"references",
	"direction",
]);
const rework = prose(dir, "inputs/design/rework-revision.md", [
	"evidence",
	"nodes",
	"causes",
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
	const changes: string[] = [];
	const proposed = current.nodes.map((label) => {
		const entry = renderMandate(current.mandate, [label]);
		const bound = renderMandate(base, [label]);
		const old = previous ? renderMandate(previous.mandate, [label]) : bound;
		if (previous && old !== entry)
			changes.push(`${label} ${!old ? "new" : !entry ? "removed" : "changed"}`);
		if (!entry) return `### ${label} (removed)`;
		const fields = bound
			? changedFields(
					mandateFields(base, label),
					mandateFields(current.mandate, label),
				)
			: [];
		const marked = entry.replace(
			"\n",
			` (${bound ? "changed" : "new"})\n${fields.length ? `\nChanged: ${fields.join(", ")}\n` : ""}`,
		);
		return previous && old && old !== entry
			? `${marked}\n\n#### Previously\n\n${old.replace(/^### (.+)$/m, "**$1**")}`
			: marked;
	});
	const removed =
		previous?.nodes.filter((l) => !current.nodes.includes(l)) ?? [];
	changes.push(...removed.map((l) => `${l} reverted to bound`));
	return {
		subject: subject(`revision/${index + 1}/${r.rounds.length}`),
		title: `Review Mandate revision: ${current.nodes.join(", ")}`,
		basis: review({
			summary: previous
				? `Since round ${r.rounds.length - 1}: ${changes.join(", ") || "no nodes changed"}.\n`
				: "",
			evidence: r.text,
			plan: current.plan ?? "No plan items affected.",
			before: renderMandate(base, current.nodes),
			after: proposed.join("\n\n"),
			history: previous
				? precedingRound(
						renderMandate(previous.mandate, removed),
						owed(previous)
							.map((a) => {
								const reply = current.replies.find((n) => n.n === a.n)!;
								return `${annotation(a)}\n\n   ${reply.status}: ${reply.reason}`;
							})
							.join("\n"),
					)
				: "",
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
		tools: ["publish_revision", "revision_settled"],
		situation: "shape",
		input: () => {
			const fields = {
				evidence: r.text,
				nodes: r.nodes.join(", "),
				causes: r.causes.join(", "),
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
		annotations: notPursued(a) || "None.",
	});
export const sameCauses = (causes: string[], reply: string[]) =>
	causes.length === reply.length && causes.every((c) => reply.includes(c));
