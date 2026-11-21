import { subject } from "../../kernel/ids.ts";
import { type Ask, type KernelEvent, prose } from "../../kernel/lane.ts";
import { type Audit, type Draft, draftError, nodes } from "./draft.ts";
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
export type Round = {
	draft: Draft;
	replies: Reply[];
	answer: Answer | null;
};
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
const riderText = prose(dir, "documents/mandate-rider.md", [
	"text",
	"origin",
	"disposition",
]);
const draftInput = prose(dir, "inputs/design/draft.md", [
	"reference",
	"audit",
	"direction",
]);
const revise = prose(dir, "inputs/design/revise.md", [
	"basis",
	"answer",
	"direction",
]);
const declined = prose(dir, "documents/declined.md", ["annotations"]);
const mainKey = (n: number) => subject(`mandate/${n}`);
const owed = (r: Round | undefined) =>
	r?.answer?.choice === "rework" ? r.answer.annotations : [];

export function openRound(
	audit: Audit,
	history: Round[],
	draft: Draft,
	replies: Reply[],
): { reject: string } | { round: Round } {
	const error = draftError(draft, audit);
	if (error) return { reject: error };
	if (!repliesCover(owed(history.at(-1)).length, replies))
		return {
			reject:
				"Reply to every owed number exactly once: acted_on, considered or dismissed, with a reason.",
		};
	return { round: { draft, replies, answer: null } };
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
function repliesText(r: Round, prev: Round | undefined) {
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
function entries(d: Draft, a: Audit): Entry[] {
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
function entryText(n: Entry, mark = "") {
	return `### ${n.label}: ${n.section}${mark}\n\n${entryBody(n)}`;
}
function body(
	a: Audit,
	reference: string,
	history: Round[],
	showChanges = true,
) {
	const r = history.at(-1)!;
	const prev = showChanges ? history.at(-2) : undefined;
	const previous = prev ? entries(prev.draft, a) : [];
	const current = entries(r.draft, a);
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
		sections[n.group].push(entryText(n, change ? ` (${change})` : "") + before);
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
				? roundHistory({
						removed: removed.map((p) => entryText(p)).join("\n\n") || "None.",
						replies: repliesText(r, prev),
					})
				: "",
		}),
	};
}
export function reviewAsk(
	a: Audit,
	reference: string,
	history: Round[],
): Ask | null {
	const r = history.at(-1)!;
	if (r.answer) return null;
	return {
		subject: mainKey(history.length),
		title: `Review Mandate: ${r.draft.intent.trim().split("\n", 1)[0]}`,
		basis: review({
			round: String(history.length),
			...body(a, reference, history),
		}),
		choices: ["approve", "rework", "decline"],
	};
}
export function designerInput(
	a: Audit,
	reference: string,
	history: Round[],
	direction: string,
) {
	if (!history.length)
		return draftInput({
			reference,
			audit: [
				a.exists,
				...a.gaps.map((g) => `Gap ${g.label}: ${g.text}`),
				...a.contradictions.map((g) => `Contradiction ${g.label}: ${g.text}`),
			].join("\n"),
			direction,
		});
	return revise({
		basis: body(a, reference, history, false).body.trimEnd(),
		answer:
			owed(history.at(-1))
				.map((n) => annotation(n))
				.join("\n") || "None.",
		direction,
	});
}
export function answered(
	a: Audit,
	reference: string,
	history: Round[],
	f: Fact,
) {
	if (f.subject !== mainKey(history.length)) return null;
	const ask = reviewAsk(a, reference, history);
	if (!ask?.choices.includes(f.choice)) return null;
	const answer = reviewAnswer(f, ask.basis);
	return {
		rounds: [...history.slice(0, -1), { ...history.at(-1)!, answer }],
		phase:
			f.choice === "approve"
				? ("bound" as const)
				: f.choice === "rework"
					? ("drafting" as const)
					: ("closed" as const),
	};
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
					: { label, section, body },
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
