import {
	type Annotation,
	type DecisionId,
	decision,
	type EventData,
	options,
} from "tau";
import type { Draft } from "tau/chord";
import {
	type ConversationId,
	defineDoc,
	defineEntry,
	type EntryId,
	type Tx,
} from "tau/durable";
import { obj, str } from "tau/schema";

export const KeelOptions = options(
	"keel",
	obj({
		designer: str({ format: "model" }),
		worker: str({ format: "model" }),
		verifier: str({ format: "model" }),
		base: str({ minLength: 1, default: "main" }),
	}),
);

export type Stage =
	| "designing"
	| "mandate_review"
	| "preparing"
	| "building"
	| "verifying"
	| "reworking"
	| "handover_review"
	| "handed_over"
	| "cancelled"
	| "stopped";

/** Stored before the worktree exists (row 8). `repo` is the designer's `cwd`, copied for the outside effect. */
export type Plan = {
	repo: string;
	path: string;
	branch: string;
	base: string;
	baseSha: string;
};

export type Subject = "mandate" | "handover" | "stuck";

/** One piece of work, on D. D's conversation ID is the work's key `k`. */
export type WorkState = {
	stage: Stage;
	/** The decision Keel still waits on, per subject. A `then` task acts only on the one named here. */
	waiting: { [S in Subject]?: DecisionId };
	/** Decisions whose `then` work has landed. A `then` task created again for one of them does nothing. */
	handled: Record<string, true>;
	/** Where "retry" on the stuck decision goes: a role's conversation, or the worktree again. */
	retry?: ConversationId | "prepare" | "checkout";
	/** The answer whose annotations the next publish must reply to. */
	owes?: DecisionId;
	accepted?: { mandate: EntryId; decision: DecisionId };
	plan?: Plan;
	worker?: ConversationId;
	verifier?: ConversationId;
	verifierModel?: string;
	candidate?: {
		build: EntryId;
		sha: string;
		checkout: string;
		verdict?: EntryId;
	};
	pendingRulings: EntryId[];
	/** Only blocks in the last verdict, keyed by their displayed finding number. */
	blockCounts: Record<string, number>;
	/** A publishing tool's result, by its `api.taskId`. */
	receipts: Record<string, string>;
};

export const Work = defineDoc<WorkState>({
	kind: "keel.work",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({
		stage: "designing",
		waiting: {},
		handled: {},
		pendingRulings: [],
		blockCounts: {},
		receipts: {},
	}),
	checkpointWhen: () => true,
});

/** On I and R: the D whose work they serve. */
export const Owner = defineDoc<{ work?: ConversationId }>({
	kind: "keel.owner",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
	checkpointWhen: () => true,
});

export type Reply = { annotation: number; text: string };

export const Mandate = defineEntry<{ text: string; replies?: Reply[] }>(
	"keel.mandate",
);
export const Ruling = defineEntry<{
	decision: string;
	why: string;
	cost: string;
	cites: string;
}>("keel.ruling");

export async function listedRulings(tx: Tx, ids: readonly EntryId[]) {
	const lines: string[] = [];
	for (const [index, id] of ids.entries()) {
		const ruling = await tx.entry(Ruling, id);
		if (!ruling) throw new Error(`No ruling entry ${id}`);
		const { decision, why, cost, cites } = ruling.data;
		lines.push(
			`${index + 1}. ${decision}\n   Why: ${why}\n   Cost if wrong: ${cost}\n   Follows: ${cites}`,
		);
	}
	return lines.join("\n") || "(none)";
}

export type Finding = {
	kind: "block" | "note";
	text: string;
	repeats?: number;
};

export function listedFindings(
	findings: readonly Finding[],
	kind: Finding["kind"],
) {
	return (
		findings
			.flatMap((f, i) => (f.kind === kind ? [`${i + 1}. ${f.text}`] : []))
			.join("\n") || "(none)"
	);
}

export const Build = defineEntry<{
	text: string;
	mandate: EntryId;
	sha: string;
	rulings: EntryId[];
	replies?: Reply[];
	fixes?: EntryId;
}>("keel.build");
export const Verdict = defineEntry<{
	text: string;
	build: EntryId;
	sha: string;
	verdict: "pass" | "fail";
	findings: Finding[];
}>("keel.verdict");
export const Handover = defineEntry<{
	text: string;
	mandate: EntryId;
	sha: string;
	build: EntryId;
	verdict: EntryId;
	branch: string;
}>("keel.handover");
/** The basis of a stuck decision. */
export const Note = defineEntry<{ text: string }>("keel.note");
export const Cancel = defineEntry<{
	text: string;
	notPursued: { decision: DecisionId; annotation: number; text: string }[];
}>("keel.cancel");
export const KeelEvent = defineEntry<
	EventData & {
		stage: Stage;
		sha?: string;
		path?: string;
		notActedOn?: Annotation[];
	}
>("keel.event");

export const subject = (k: ConversationId, name: Subject) =>
	`keel:${k}:${name}`;

/** The work a conversation serves: D's own, or the one that I's or R's owner document names. */
export async function workOf(tx: Tx, conversation: ConversationId) {
	const k = (await tx.doc(Owner, conversation)).work ?? conversation;
	return { k, work: await tx.doc(Work, k) };
}

export const closed = (work: { stage: Stage }) =>
	work.stage === "cancelled" || work.stage === "stopped";

/** Whether a `then` task may act on its decision: Keel still waits on it, and no earlier task did the work. */
export const expects = (
	work: Draft<WorkState>,
	name: Subject,
	id: DecisionId,
) => work.waiting[name] === id && !work.handled[id];

export function settle(work: Draft<WorkState>, name: Subject, id: DecisionId) {
	delete work.waiting[name];
	work.handled[id] = true;
}

/** Whether this conversation's run was meant to end with a handoff in the current stage (row E2). */
export function owesHandoff(
	work: Readonly<WorkState> | Draft<WorkState>,
	k: ConversationId,
	conversation: ConversationId,
) {
	const { stage, candidate } = work;
	if (conversation === k) return stage === "designing";
	if (conversation === work.worker)
		return (
			(stage === "building" || stage === "reworking") &&
			(candidate === undefined || candidate.verdict !== undefined)
		);
	if (conversation === work.verifier)
		return stage === "verifying" && candidate?.verdict === undefined;
	return false;
}

/** The annotations of an answered decision, or none. */
export async function annotationsOf(tx: Tx, id: DecisionId | undefined) {
	const found = id === undefined ? undefined : await decision(tx, id);
	return found?.status === "answered" ? found.annotations : [];
}

/** Each annotation by its number, with the passage of `text` it names. */
export function listed(annotations: readonly Annotation[], text: string) {
	if (annotations.length === 0) return "(none)";
	return annotations
		.map(
			({ text: comment, range }, index) =>
				`${index}. ${range ? `On "${text.slice(range.start, range.end)}"` : "On the whole text"}: ${comment}`,
		)
		.join("\n");
}

/** The refusal when a publish leaves an annotation it owes without a reply (rows 5 and 11). */
export async function unreplied(
	tx: Tx,
	work: Draft<WorkState>,
	replies: readonly Reply[] | undefined,
) {
	const owed = await annotationsOf(tx, work.owes);
	const missing = owed
		.map((_, index) => index)
		.filter((index) => !replies?.some((reply) => reply.annotation === index));
	return missing.length === 0
		? undefined
		: `Reply to every annotation of ${work.owes} by its number first. Missing: ${missing.join(", ")}.`;
}
