import { arr, obj, opt } from "tau/schema";
import { subject, token } from "../../kernel/ids.ts";
import {
	type Args,
	type Ask,
	type Expectation,
	prose,
} from "../../kernel/lane.ts";
import {
	checkSchema,
	renderSeam,
	ruleSchema,
	seamSchema,
	text,
	validCheck,
	validRule,
	validSeam,
} from "./draft.ts";
import {
	changedFields,
	type Mandate,
	mandateLabels,
	mandateNodes,
	nodeBody,
	type Reply,
	renderMandate,
	renderNode,
	repliesCover,
} from "./public.ts";
import { type Answer, annotation, notPursued } from "./rounds.ts";

export const changesSchema = obj({
	intent: opt(text),
	nodes: opt(arr(ruleSchema)),
	seams: opt(arr(seamSchema)),
	checks: opt(arr(checkSchema)),
	sections: opt(arr(obj({ label: text, body: text }))),
	remove: opt(arr(text)),
});
export type Changes = Args<typeof changesSchema>;
export const causeAnswersSchema = arr(
	obj({ cause: text, nodes: arr(text), reason: text }),
);
type CauseAnswer = { cause: string; nodes: string[]; reason: string };
type RevisionRound = {
	mandate: Mandate;
	nodes: string[];
	answers: CauseAnswer[];
	changes: string;
	replies: Reply[];
	plan: string;
	answer: Answer | null;
};
export type Revision = {
	phase: "drafting" | "review" | "held" | "approved" | "applied" | "declined";
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
	answers: CauseAnswer[] | undefined,
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
	const edits = mandateEdits(base, mandate);
	const available = new Set([
		...mandateLabels(base),
		...mandateLabels(mandate),
	]);
	if (
		!Array.isArray(answers) ||
		!sameCauses(
			r.causes,
			answers.map((a) => a.cause),
		) ||
		answers.some(
			(a) =>
				!a.reason.trim() ||
				!a.nodes.length ||
				a.nodes.some((l) => !available.has(l)),
		) ||
		edits.some(({ label }) => !answers.some((a) => a.nodes.includes(label)))
	)
		return {
			reject:
				"Explain each finding once. Cite its settling or changed labels, and attribute every edit to a finding.",
		};
	return {
		round: {
			mandate,
			nodes: edits.map((e) => e.label),
			changes:
				edits
					.map(
						({ label, before, after, fields }) =>
							`${label}: ${!after ? "removed" : !before ? "added" : fields.join(", ")}`,
					)
					.join("; ") || "No Mandate change",
			answers,
			replies,
			answer: null,
			plan: "No plan items affected.",
		},
	};
}

function mandateEdits(base: Mandate, next: Mandate) {
	const old = new Map(mandateNodes(base).map((n) => [n.label, n]));
	const current = new Map(mandateNodes(next).map((n) => [n.label, n]));
	return [...new Set([...old.keys(), ...current.keys()])].flatMap((label) => {
		const before = old.get(label);
		const after = current.get(label);
		const fields = before && after ? changedFields(before, after) : [];
		return before && after && !fields.length
			? []
			: [{ label, before, after, fields }];
	});
}

export const answersText = (r: RevisionRound, evidence: string) => {
	const lines = evidence.split("\n");
	return r.answers
		.map(({ cause, nodes, reason }) => {
			const label = cause.replace(/^queue\/(\d+)$/, "Finding #$1");
			const heading = lines.find((line) => line.startsWith(`### ${label}: `));
			return `- ${heading ? heading.slice(4) : label}: ${nodes.join(", ")}. ${reason.trim()}`;
		})
		.join("\n");
};
const cited = (round: RevisionRound) => round.answers.flatMap((a) => a.nodes);

const dir = import.meta.dirname + "/../../prose";
const review = prose(dir, "documents/revision-review.md", [
	"summary",
	"disposition",
	"activation",
	"evidence",
	"before",
	"after",
	"answers",
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
	"after",
	"answers",
	"annotations",
	"direction",
]);
const decline = prose(dir, "documents/revision-declined.md", ["annotations"]);

export function revisionAsk(
	base: Mandate,
	r: Revision,
	index: number,
	seq: number,
): Ask {
	const current = r.rounds.at(-1)!;
	const previous = r.rounds.at(-2);
	const proposed = mandateEdits(base, current.mandate).map(
		({ label, before, after, fields }) => {
			if (!after) return `### ${label} (removed)`;
			const old = previous && renderMandate(previous.mandate, [label]);
			const text = renderNode(after, before ? " (changed)" : " (new)", fields);
			return old &&
				old !== renderMandate(base, [label]) &&
				old !== renderNode(after)
				? `${text}\n\n#### Previously\n\n${old.replace(/^### (.+)$/m, "**$1**")}`
				: text;
		},
	);
	const removed =
		previous?.nodes.filter((l) => !current.nodes.includes(l)) ?? [];
	return {
		subject: subject(`revision/${index + 1}/${seq}`),
		title: `Review Mandate revision: ${current.nodes.join(", ") || "no change"}`,
		basis: review({
			disposition: current.nodes.length
				? "Approve these Mandate changes"
				: "Approve keeping the Mandate unchanged",
			activation: current.nodes.length
				? "Approval takes effect when the coordinator publishes the plan."
				: "Approval without notes releases the holds. If you add approval notes, the coordinator answers them in the plan before releasing the holds.",
			summary: previous
				? `Since round ${r.rounds.length - 1}: ${
						mandateEdits(previous.mandate, current.mandate)
							.map(
								({ label, before, after }) =>
									`${label} ${removed.includes(label) ? "reverted to bound" : !after ? "removed" : !before ? "new" : "changed"}`,
							)
							.join(", ") || "no nodes changed"
					}.\n`
				: "",
			evidence: r.text,
			plan: current.plan,
			before:
				renderMandate(base, cited(current)) || "No existing nodes change.",
			after: proposed.join("\n\n") || "No change to the Mandate.",
			answers: answersText(current, r.text),
			history: current.replies.length
				? `## Replies to the preceding round\n\n${owed(previous)
						.map((a) => {
							const reply = current.replies.find((n) => n.n === a.n)!;
							return `${annotation(a)}\n\n   ${reply.status}: ${reply.reason}`;
						})
						.join("\n")}`
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
		tools: ["publish_revision"],
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
						after:
							renderMandate(previous.mandate, previous.nodes) ||
							"No change to the Mandate.",
						answers: answersText(previous, r.text),
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
