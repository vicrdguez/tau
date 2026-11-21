import { subject } from "../../kernel/ids.ts";
import { type Ask, type KernelEvent, prose } from "../../kernel/lane.ts";
import {
	type Audit,
	changedFields,
	type Draft,
	draftError,
	nodes,
	seamFields,
} from "./draft.ts";
import { type Mandate, type Reply, repliesCover } from "./public.ts";

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
	grafts: { seat: string; text: string }[];
	evidence: { id: number; node: string; text: string }[];
};
export type Round = Synthesis & {
	arena: number;
	challenge: number;
	dispositions: Reply[];
	answer: Answer | null;
};
type DraftRound = Pick<Round, "draft" | "replies" | "answer" | "evidence">;
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
]);
export const precedingRound = (removed: string, replies: string) =>
	roundHistory({ removed: removed || "None.", replies: replies || "None." });
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

type Entry = {
	label: string;
	section: string;
	body: string;
	group: "nodes" | "riders" | "considerations";
	probe?: string;
	reference?: string;
};
function entries({ draft: d, evidence }: DraftRound, a: Audit): Entry[] {
	const result: Entry[] = [
		...nodes(d, a, "Proposed ruling").map((n) => ({
			...n,
			group: "nodes" as const,
		})),
		...d.riders.map((r) => ({
			label: r.label,
			section: "Rider",
			group: "riders" as const,
			body: riderText(r).trim(),
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
		body: [
			n.body,
			...evidence.filter((e) => e.node === n.label).map((e) => e.text),
		].join("\n\n"),
		reference: d.references.find((r) => r.label === n.label)?.source ?? "",
	}));
}
function entryBody(n: Entry) {
	return [
		n.body,
		...(n.probe
			? [
					`${n.label === "intent" ? "Done when" : "Falsifying probe"}: ${n.probe}`,
				]
			: []),
		...(n.reference ? [`Reference: ${n.reference}`] : []),
	].join("\n\n");
}
function entryFields(n: Entry, d: Draft) {
	const seam = d.seams.find((entry) => entry.label === n.label);
	const check = d.checks.find((entry) => entry.id === n.label);
	const rider = d.riders.find((entry) => entry.label === n.label);
	return {
		section: n.section,
		...(seam
			? seamFields(seam)
			: check
				? { command: check.argv, timeout: check.timeoutMs }
				: rider
					? {
							text: rider.text,
							origin: rider.origin,
							disposition: rider.disposition,
						}
					: {
							[n.label === "intent"
								? "intent"
								: n.section === "Rule"
									? "rule"
									: "text"]: n.body,
							[n.label === "intent" ? "done when" : "falsifying probe"]:
								n.probe || undefined,
						}),
		reference: n.reference,
	};
}
function entryText(n: Entry, mark = "", fields: string[] = []) {
	const heading = fields.length ? `Changed: ${fields.join(", ")}\n\n` : "";
	return `### ${n.label}: ${n.section}${mark}\n\n${heading}${entryBody(n)}`;
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
			? `\n\n#### Previously\n\n**${old.label}: ${old.section}**\n\n${entryBody(old)}`
			: "";
		const fields =
			prev && old && changed
				? changedFields(entryFields(old, prev.draft), entryFields(n, r.draft))
				: [];
		sections[n.group].push(
			entryText(n, change ? ` (${change})` : "", fields) + before,
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
						removed.map((p) => entryText(p)).join("\n\n"),
						repliesText(r, prev),
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
	return {
		subject: mainKey(history.length),
		title: `Review Mandate: ${r.draft.intent.trim().split("\n", 1)[0]}`,
		basis: review({
			round: String(history.length),
			changes: document.changes,
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
