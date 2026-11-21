import { subject } from "../../kernel/ids.ts";
import { type Ask, type KernelEvent, prose } from "../../kernel/lane.ts";
import type { Outcome } from "./accounting.ts";
import { type Audit, type Draft, draftError, nodes } from "./draft.ts";
import {
	changedFields,
	type Mandate,
	type MandateNode,
	nodeBody,
	type Reply,
	renderNode,
	repliesCover,
} from "./public.ts";

type Fact = Extract<KernelEvent, { kind: "answered" }>;
export type Answer = {
	decision: string;
	choice: string;
	annotations: {
		n: number;
		text: string;
		range: { start: number; end: number } | null;
		excerpt: string | null;
	}[];
};
export type Synthesis = {
	draft: Draft;
	replies: Reply[];
	base: string;
	grafts: { seat: string; label: string; text: string }[];
	outcomes: Outcome[];
	experimentCount: number;
};
export type Round = Synthesis & {
	arena: number;
	challenge: number;
	dispositions: Reply[];
	answer: Answer | null;
};
type DraftRound = Pick<Round, "draft" | "replies" | "answer">;
const dir = import.meta.dirname + "/../../prose";
const review = prose(dir, "documents/review.md", ["round", "changes", "body"]);
const roundText = prose(dir, "documents/mandate-round.md", [
	"reference",
	"exists",
	"nodes",
	"riders",
	"considerations",
	"history",
]);
const roundHistory = prose(dir, "documents/mandate-round-history.md", [
	"removed",
	"replies",
	"heading",
]);
export const precedingRound = (
	removed: string,
	replies: string,
	heading = "##",
) =>
	roundHistory({
		removed: removed || "None.",
		replies: replies || "None.",
		heading,
	});
const riderText = prose(dir, "documents/mandate-rider.md", [
	"text",
	"origin",
	"disposition",
]);
const draftInput = prose(dir, "inputs/design/draft.md", [
	"ground",
	"evidence",
	"base",
	"answer",
	"direction",
]);
const revise = prose(dir, "inputs/design/revise.md", [
	"basis",
	"base",
	"answer",
	"direction",
]);
const declined = prose(dir, "documents/declined.md", ["annotations"]);
const baseText = prose(dir, "documents/arena-base.md", ["base", "grafts"]);
export function synthesisSources(s: Synthesis) {
	return baseText({
		base: s.base,
		grafts:
			s.grafts
				.map((g) => `- ${g.seat} → \`${g.label}\`: ${g.text}`)
				.join("\n") || "None.",
	});
}
const mainKey = (n: number) => subject(`mandate/${n}`);
export const continuesReview = (choice: string) =>
	["rework", "arena", "arena_fresh"].includes(choice) ||
	choice.startsWith("base:");
const owed = (r: DraftRound | undefined) =>
	r?.answer && continuesReview(r.answer.choice) ? r.answer.annotations : [];
export const owedText = (r: Round | undefined) =>
	owed(r)
		.map((n) => annotation(n))
		.join("\n") || "None.";

export function synthesisError(
	audit: Audit,
	history: Round[],
	synthesis: Synthesis,
) {
	return (
		draftError(synthesis.draft, audit) ||
		(!repliesCover(owed(history.at(-1)).length, synthesis.replies)
			? "Reply to every owed number exactly once: acted_on, considered or dismissed, with a reason."
			: null)
	);
}
function passage(a: Answer["annotations"][number]) {
	return a.excerpt === null
		? ""
		: `\n${a.excerpt
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")}`;
}
export function annotation(a: Answer["annotations"][number], status = "") {
	return `${a.n}. ${a.text}${status}${passage(a)}`;
}
function repliesText(r: DraftRound, prev: DraftRound | undefined) {
	return (
		owed(prev)
			.map((a) => {
				const reply = r.replies.find((v) => v.n === a.n)!;
				return `${annotation(a)}\n\n   ${reply.status}: ${reply.reason}`;
			})
			.join("\n") || "None."
	);
}

type Entry = MandateNode & { group: "nodes" | "riders" | "considerations" };
function entries({ draft: d }: DraftRound, a: Audit): Entry[] {
	const result: Entry[] = [
		...nodes(d, a, "Proposed ruling").map((n) => ({
			...n,
			group: "nodes" as const,
			seam: d.seams.find((s) => s.label === n.label),
			check: d.checks.find((c) => c.id === n.label),
		})),
		...d.riders.map((r) => ({
			label: r.label,
			section: "Rider",
			group: "riders" as const,
			body: riderText(r).trim(),
			rider: r,
		})),
		{
			label: "tradeoffs",
			section: "Tradeoffs",
			group: "considerations",
			body: d.tradeoffs,
		},
		{
			label: "alternatives",
			section: "Alternatives considered",
			group: "considerations",
			body: d.alternatives,
		},
	];
	return result.map((n) => ({
		...n,
		reference: d.references.find((r) => r.label === n.label)?.source ?? "",
	}));
}
function body(
	a: Audit,
	reference: string,
	history: DraftRound[],
	showChanges = true,
) {
	const r = history.at(-1)!;
	const prev = showChanges ? history.at(-2) : undefined;
	const previous = prev ? entries(prev, a) : [];
	const current = entries(r, a);
	const sections: Record<Entry["group"], string[]> = {
		nodes: [],
		riders: [],
		considerations: [],
	};
	const summary: string[] = [];
	const label = (n: Entry) =>
		n.group === "riders" ? `rider ${n.label}` : n.label;
	for (const n of current) {
		const old = previous.find((p) => p.label === n.label);
		const changed =
			old &&
			(old.group !== n.group ||
				old.section !== n.section ||
				old.body !== n.body ||
				old.probe !== n.probe ||
				old.reference !== n.reference);
		const change = !prev ? null : !old ? "new" : changed ? "changed" : null;
		if (change) summary.push(`${label(n)} ${change}`);
		const before = changed
			? `\n\n#### Previously\n\n**${old.label}: ${old.section}**\n\n${nodeBody(old)}`
			: "";
		const fields = prev && old && changed ? changedFields(old, n) : [];
		sections[n.group].push(
			renderNode(n, change ? ` (${change})` : "", fields) + before,
		);
	}
	const removed = previous.filter(
		(p) => !current.some((n) => n.label === p.label),
	);
	summary.push(...removed.map((n) => `${label(n)} removed`));
	return {
		changes: prev
			? ` Since round ${history.length - 1}: ${summary.join(", ") || "no entries changed"}.`
			: "",
		body: roundText({
			reference,
			exists: a.exists,
			nodes: sections.nodes.join("\n\n"),
			riders: sections.riders.join("\n\n") || "None.",
			considerations: sections.considerations.join("\n\n"),
			history: prev
				? precedingRound(
						removed.map((p) => renderNode(p)).join("\n\n"),
						repliesText(r, prev),
						"###",
					)
				: "",
		}),
	};
}
export function reviewAsk(
	a: Audit,
	reference: string,
	history: Round[],
	evidence: string,
	candidates: string[],
): Ask {
	const r = history.at(-1)!;
	const document = body(a, reference, history);
	const prev = history.at(-2);
	const switched =
		prev?.arena === r.arena && prev.base !== r.base
			? ` Base switched to \`${r.base}\`, replacing \`${prev.base}\`.`
			: "";
	return {
		subject: mainKey(history.length),
		title: `Review Mandate: ${r.draft.intent.trim().split("\n", 1)[0]}`,
		basis: review({
			round: String(history.length),
			changes: switched + document.changes,
			body: document.body.trimEnd() + "\n\n" + evidence,
		}),
		choices: [
			"approve",
			"rework",
			...candidates.map((seat) => `base:${seat}`),
			"arena",
			"arena_fresh",
			"decline",
		],
	};
}
export const auditText = (a: Audit, reference: string) =>
	[
		reference,
		a.exists,
		...a.gaps.map((g) => `Gap ${g.label}: ${g.text}`),
		...a.contradictions.map((g) => `Contradiction ${g.label}: ${g.text}`),
	].join("\n\n");
export const synthesisBody = (
	a: Audit,
	reference: string,
	synthesis: Synthesis,
) => body(a, reference, [{ ...synthesis, answer: null }]).body;

export function designerInput(
	a: Audit,
	reference: string,
	history: Round[],
	arena: number,
	evidence: string,
	base: string,
	direction: string,
) {
	const previous = history.at(-1);
	const common = { base, answer: owedText(previous), direction };
	return previous?.arena === arena
		? revise({
				...common,
				basis:
					body(a, reference, history, false).body.trimEnd() + "\n\n" + evidence,
			})
		: draftInput({ ...common, ground: auditText(a, reference), evidence });
}
export function reviewAnswer(f: Fact, basis: string): Answer {
	return {
		decision: f.decision,
		choice: f.choice,
		annotations: f.annotations.map(({ n, text, range }) => ({
			n,
			text,
			range: range ?? null,
			excerpt: range ? basis.slice(range.start, range.end) : null,
		})),
	};
}
export const approvalNotes = (a: Answer) =>
	a.annotations.map((n) => n.text + passage(n));
export const notPursued = (a: Answer) =>
	a.annotations.map((n) => annotation(n, ": not pursued")).join("\n");
export function declineText(history: Round[]) {
	return declined({
		annotations:
			history
				.map(({ answer }, i) =>
					(answer?.choice === "approve" || answer?.choice === "decline") &&
					answer.annotations.length
						? `### Round ${i + 1}\n\n${notPursued(answer)}`
						: "",
				)
				.filter(Boolean)
				.join("\n\n") || "None.",
	});
}
export function binding(a: Audit, history: Round[]): Mandate {
	const d = history.at(-1)!.draft;
	const ns = nodes(d, a, "Ruling").filter(
		(n) => n.label !== "intent" && n.section !== "Proof",
	);
	return {
		encodeRequired: d.seams.length > 0 || d.nodes.length > 0,
		approvalNotes: history.flatMap((r) =>
			r.answer?.choice === "approve"
				? r.answer.annotations.map((n) => n.text + passage(n))
				: [],
		),
		delegated: d.riders
			.filter((r) => r.disposition === "open")
			.map(({ label, text, origin }) => ({ label, text, origin })),
		intent: `${d.intent}\n\nDone when: ${d.done}`,
		nodes: [
			...ns.map(({ label, section, body, probe }) =>
				section === "Rule"
					? { label, rule: body, probe }
					: {
							label,
							section,
							body,
							...(section === "Seam" && {
								seam: d.seams.find((s) => s.label === label)!,
							}),
						},
			),
			...d.riders
				.filter((r) => r.disposition === "bind")
				.map((r) => ({
					label: r.label,
					section: `Rider (${r.origin})`,
					body: r.text,
				})),
		],
		checks: d.checks,
		considerations: { tradeoffs: d.tradeoffs, alternatives: d.alternatives },
	};
}
