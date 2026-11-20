import { subject } from "../../kernel/ids.ts";
import { type Ask, type KernelEvent, prose } from "../../kernel/lane.ts";
import { type Audit, type Draft, draftError, nodes, paths } from "./draft.ts";
import { type Mandate, type Reply, repliesCover } from "./public.ts";

type Fact = Extract<KernelEvent, { kind: "answered" }>;
type Answer = {
	decision: string;
	choice: string;
	annotations: {
		n: number;
		text: string;
		range: { start: number; end: number } | null;
	}[];
};
export type Round = {
	draft: Draft;
	replies: Reply[];
	labels: string[];
	answer: Answer | null;
	riders: { label: string; answer: Answer | null }[];
};
const dir = import.meta.dirname + "/../../prose";
const review = prose(dir, "documents/review.md", [
	"round",
	"labels",
	"reference",
	"exists",
	"nodes",
	"removed",
	"riders",
	"replies",
]);
const rider = prose(dir, "documents/rider.md", ["label", "text", "origin"]);
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
const riderKey = (n: number, l: string) => subject(`rider/${n}/${l}`);
const redesign = (r: Round) =>
	r.riders.find((v) => v.answer?.choice === "design");
function owed(r: Round) {
	return r.answer?.choice === "rework"
		? r.answer.annotations
		: (redesign(r)?.answer?.annotations ?? []);
}
const source = (d: Draft, label: string) =>
	d.references.find((r) => r.label === label)?.source;
function sameRider(prev: Round, r: Draft["riders"][number]) {
	return prev.draft.riders.some(
		(p) => p.label === r.label && p.origin === r.origin && p.text === r.text,
	);
}

export function openRound(
	audit: Audit,
	history: Round[],
	draft: Draft,
	replies: Reply[],
): { reject: string } | { round: Round } {
	const error = draftError(draft, audit);
	if (error) return { reject: error };
	const prev = history.at(-1);
	const debt = prev ? owed(prev) : [];
	if (!repliesCover(debt.length, replies))
		return {
			reject:
				"Reply to every owed number exactly once: acted_on, considered or dismissed, with a reason.",
		};
	const ns = nodes(draft, audit);
	const old = prev ? nodes(prev.draft, audit) : [];
	const designed = prev && redesign(prev)?.label;
	if (
		designed &&
		(!ns.some((n) => n.label === designed) || source(draft, designed))
	)
		return {
			reject: `Design ${designed} as a node for the owner's review under the same label.`,
		};
	// A dropped rider may not return later under its old label as an ordinary node.
	if (
		ns.some(
			(n) =>
				n.label !== designed &&
				!old.some((p) => p.label === n.label) &&
				history.some((r) => r.riders.some((p) => p.label === n.label)),
		)
	)
		return {
			reject:
				"Only the owner's design choice converts a rider to a proposed node.",
		};
	const labels = ns
		.filter((n) => {
			const prior = old.find((p) => p.label === n.label);
			if (!prior)
				return (
					!source(draft, n.label) ||
					history.some((r) =>
						nodes(r.draft, audit).some((p) => p.label === n.label),
					)
				);
			if (
				prior.body !== n.body ||
				prior.probe !== n.probe ||
				prior.section !== n.section ||
				source(prev!.draft, n.label) !== source(draft, n.label)
			)
				return true;
			return (
				prev!.answer?.choice !== "approve" && prev!.labels.includes(n.label)
			);
		})
		.map((n) => n.label);
	// A removal is a change too, not an invisible way to drop an obligation.
	if (prev) labels.push(...removed(prev, draft, audit));
	return {
		round: {
			draft,
			replies,
			labels,
			answer: null,
			riders: draft.riders.map((r) => ({
				label: r.label,
				answer:
					prev && sameRider(prev, r)
						? (prev.riders.find((p) => p.label === r.label)?.answer ?? null)
						: null,
			})),
		},
	};
}
function removed(prev: Round, d: Draft, a: Audit) {
	const current = new Set([...nodes(d, a), ...d.riders].map((n) => n.label));
	return [...nodes(prev.draft, a), ...prev.draft.riders]
		.filter((n) => !current.has(n.label))
		.map((n) => n.label);
}
function annotation(a: Answer["annotations"][number]) {
	return `${a.n}. ${a.text}${a.range ? ` [${a.range.start}:${a.range.end}]` : ""}`;
}
function repliesText(r: Round, prev: Round | undefined) {
	return (
		(prev ? owed(prev) : [])
			.map((a) => {
				const reply = r.replies.find((v) => v.n === a.n)!;
				return `${annotation(a)}\n   ${reply.status}: ${reply.reason}`;
			})
			.join("\n") || "None."
	);
}
function basis(a: Audit, reference: string, history: Round[]) {
	const r = history.at(-1)!;
	const prev = history.at(-2);
	return review({
		round: String(history.length),
		labels: r.labels.join(", ") || "None.",
		reference,
		exists: a.exists,
		nodes: nodes(r.draft, a)
			.map(
				(n) =>
					`### ${n.label}: ${n.section}\n\n${n.body}${n.probe ? `\n\n${n.label === "intent" ? "Done when" : "Falsifying probe"}: ${n.probe}` : ""}${source(r.draft, n.label) ? `\n\nReference: ${source(r.draft, n.label)}` : ""}`,
			)
			.join("\n\n"),
		removed: prev ? removed(prev, r.draft, a).join(", ") || "None." : "None.",
		riders:
			r.draft.riders
				.map((v) => {
					const prior =
						prev && sameRider(prev, v)
							? prev.riders.find((p) => p.label === v.label)?.answer?.choice
							: null;
					return `- ${v.label} (${v.origin}${prior ? "; " + prior : ""}): ${v.text}`;
				})
				.join("\n") || "None.",
		replies: repliesText(r, prev),
	});
}
export function reviewAsks(
	a: Audit,
	reference: string,
	history: Round[],
): Ask[] {
	const r = history.at(-1)!;
	const n = history.length;
	const asks: Ask[] = [];
	if (!r.answer) {
		const text = basis(a, reference, history);
		asks.push({
			subject: mainKey(n),
			title: text.split("\n", 1)[0]!,
			basis: text,
			choices: ["approve", "rework", "decline"],
		});
	}
	for (const entry of r.riders) {
		if (entry.answer) continue;
		const info = r.draft.riders.find((v) => v.label === entry.label)!;
		const text = rider(info);
		asks.push({
			subject: riderKey(n, entry.label),
			title: text.split("\n", 1)[0]!,
			basis: text,
			choices: ["accept", "leave_open", "design"],
		});
	}
	return asks;
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
	const r = history.at(-1)!;
	const designed = redesign(r);
	return revise({
		basis: basis(a, reference, history),
		answer: [
			designed
				? `Design ${designed.label}: ${r.draft.riders.find((v) => v.label === designed.label)!.text}`
				: "Rework the Mandate.",
			...owed(r).map(annotation),
		].join("\n"),
		direction,
	});
}
export function answered(history: Round[], f: Fact) {
	const n = history.length;
	const r = history.at(-1)!;
	const answer: Answer = {
		decision: f.decision,
		choice: f.choice,
		annotations: f.annotations.map((a) => ({ ...a, range: a.range ?? null })),
	};
	let next: Round;
	if (
		f.subject === mainKey(n) &&
		!r.answer &&
		["approve", "rework", "decline"].includes(f.choice)
	)
		next = { ...r, answer };
	else {
		const i = r.riders.findIndex(
			(v) => !v.answer && riderKey(n, v.label) === f.subject,
		);
		if (i === -1 || !["accept", "leave_open", "design"].includes(f.choice))
			return null;
		next = {
			...r,
			riders: r.riders.map((v, j) => (i === j ? { ...v, answer } : v)),
		};
	}
	const rounds = [...history.slice(0, -1), next];
	return {
		rounds,
		phase:
			next.answer?.choice === "decline"
				? ("closed" as const)
				: next.answer?.choice === "rework" || redesign(next)
					? ("drafting" as const)
					: next.answer?.choice === "approve" &&
							next.riders.every((v) => v.answer)
						? ("bound" as const)
						: ("review" as const),
	};
}
export function declineText(r: Round) {
	return declined({
		annotations:
			r
				.answer!.annotations.map((a) => `${annotation(a)}: not pursued`)
				.join("\n") || "None.",
	});
}
export function binding(
	a: Audit,
	reference: string,
	history: Round[],
): Mandate {
	const r = history.at(-1)!;
	const d = r.draft;
	const ns = nodes(d, a).filter(
		(n) =>
			!["intent", "protectedPaths", ...d.checks.map((c) => c.id)].includes(
				n.label,
			),
	);
	const accepted = d.riders.filter((p) =>
		r.riders.some((v) => p.label === v.label && v.answer?.choice === "accept"),
	);
	return {
		reviewed: true,
		encodeRequired: d.seams.length + d.nodes.length > 0 || accepted.length > 0,
		approvalNotes: history.flatMap((v, i) => {
			if (v.answer?.choice !== "approve" || !v.answer.annotations.length)
				return [];
			const doc = basis(a, reference, history.slice(0, i + 1));
			return v.answer.annotations.map((n) =>
				n.range
					? `${n.text}\n> ${doc.slice(n.range.start, n.range.end)}`
					: n.text,
			);
		}),
		delegated: d.riders
			.filter((p) =>
				r.riders.some(
					(v) => p.label === v.label && v.answer?.choice === "leave_open",
				),
			)
			.map(({ label, text }) => ({ label, text })),
		intent: `${d.intent}\n\nDone when: ${d.done}`,
		nodes: [
			...ns.map(({ label, section, body, probe }) =>
				section === "Rule"
					? { label, rule: body, probe }
					: { label, section, body },
			),
			...accepted.map((v) => ({
				label: v.label,
				section: "Accepted rider",
				body: v.text,
			})),
		],
		checks: d.checks,
		protectedPaths: paths(d),
	};
}
