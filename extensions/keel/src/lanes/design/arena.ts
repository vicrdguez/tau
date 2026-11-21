import { arr, compile, int, obj } from "tau/schema";
import { effectKey, subject } from "../../kernel/ids.ts";
import {
	type Ask,
	type EffectDecl,
	type KernelEvent,
	prose,
	type StaticFacts,
} from "../../kernel/lane.ts";
import { text } from "./draft.ts";

const candidateSeats = [
	"arena_seat_1",
	"arena_seat_2",
	"arena_seat_3",
] as const;
const candidateHeadings = ["Usage", "Sketch", "Rationale", "Unasked Decisions"];
const judgeSchema = compile(
	obj({
		base: text,
		scores: arr(
			obj({
				seat: text,
				score: int({ minimum: 0, maximum: 10 }),
				reason: text,
				unaskedDecisions: text,
			}),
		),
	}),
);
const challengerSchema = compile(obj({ objections: arr(text) }));

export const frameSchema = obj({ question: text, rubric: text });
export const graftsSchema = arr(obj({ seat: text, text }));
type Frame = { question: string; rubric: string };
type Seat = { seat: string; model: string };
type Job = Seat & { question: string };
type Receipt = {
	seat: string;
	conversation: string;
	answer: string | null;
	error: string | null;
};
type Run = {
	stage: "candidates" | "judge" | "challenger";
	jobs: Job[];
	outcome: { results: Receipt[]; error: string | null } | null;
};
export type Arena = {
	frame: Frame;
	seedRound: number | null;
	setup:
		| { candidates: Seat[]; judge: string; challenger: string }
		| { error: string };
	runs: Run[];
	forcedBase: string | null;
};

const dir = import.meta.dirname + "/../../prose";
const candidateQuestion = prose(dir, "inputs/design/arena-candidates.md", [
	"ground",
	"question",
	"rubric",
	"seed",
]);
const judgeQuestion = prose(dir, "inputs/design/arena-judge.md", [
	"question",
	"rubric",
	"candidates",
]);
const challengerQuestion = prose(dir, "inputs/design/arena-challenger.md", [
	"question",
	"rubric",
	"base",
	"synthesis",
	"judge",
]);
const evidence = prose(dir, "documents/arena-evidence.md", [
	"arena",
	"question",
	"rubric",
	"candidates",
	"judge",
]);
const blocked = prose(dir, "documents/arena-blocked.md", ["error"]);
const baseText = prose(dir, "documents/arena-base.md", ["base", "grafts"]);

function setup(options: StaticFacts["options"]): Arena["setup"] {
	const seats = options.arena_seat_3
		? candidateSeats
		: candidateSeats.slice(0, 2);
	const family = (model: string) => model.split("/", 1)[0];
	const candidates = seats.map((seat) => ({
		seat,
		model: options[seat] ?? options.design,
	}));
	const problems: string[] = [];
	for (const { seat, model } of candidates) {
		const matches = candidates.filter((s) => family(s.model) === family(model));
		if (matches.length > 1 && matches[0]?.seat === seat)
			problems.push(
				`Set ${matches.map((s) => `\`${s.seat}\``).join(", ")} to different providers (currently \`${family(model)}\`).`,
			);
	}
	const judge = options.arena_judge ?? options.design;
	if (family(judge) === family(options.designer ?? options.design))
		problems.push(
			"Set `arena_judge` to a different provider from the `designer` model (which defaults to `design`).",
		);
	return problems.length
		? { error: problems.join("\n\n") }
		: {
				candidates,
				judge,
				challenger: options.arena_challenger ?? options.design,
			};
}

export function startArena(
	frame: Frame,
	seedRound: number | null,
	w: StaticFacts,
): Arena {
	return {
		frame,
		seedRound,
		setup: setup(w.options),
		runs: [],
		forcedBase: null,
	};
}

function plan(arena: Arena, stage: Run["stage"], jobs: Job[]): Arena {
	return { ...arena, runs: [...arena.runs, { stage, jobs, outcome: null }] };
}
export function startCandidates(arena: Arena, ground: string, seed: string) {
	if ("error" in arena.setup) return { phase: "arena_blocked" as const, arena };
	const question = candidateQuestion({ ...arena.frame, ground, seed });
	return {
		phase: "dispatching" as const,
		arena: plan(
			arena,
			"candidates",
			arena.setup.candidates.map((seat) => ({ ...seat, question })),
		),
	};
}
export function retryArena(
	arena: Arena,
	ground: string,
	seed: string,
	w: StaticFacts,
) {
	const run = arena.runs.at(-1);
	return run
		? { phase: "dispatching" as const, arena: plan(arena, run.stage, run.jobs) }
		: startCandidates({ ...arena, setup: setup(w.options) }, ground, seed);
}
export function blockedAsk(arena: Arena, seq: number): Ask {
	const error =
		"error" in arena.setup
			? arena.setup.error
			: arena.runs.at(-1)!.outcome!.error!;
	return {
		subject: subject(`arena/failure/${seq}`),
		title: "Retry the arena or decline the work?",
		basis: blocked({ error }),
		choices: ["retry", "decline"],
	};
}

export function arenaEffect(arena: Arena, number: number): EffectDecl {
	const { stage, jobs } = arena.runs.at(-1)!;
	return {
		key: effectKey(`arena/${number}/${stage}/${arena.runs.length}`),
		spec: { kind: "arena_dispatch", jobs },
	};
}

type EffectFact = Extract<
	KernelEvent,
	{ kind: "effect_done" | "effect_failed" }
>;
function receipts(fact: EffectFact, run: Run): NonNullable<Run["outcome"]> {
	if (fact.kind === "effect_failed") return { results: [], error: fact.error };
	const value = fact.result.results;
	const invalid = {
		results: [],
		error: "The dispatch result does not match the planned seats in order.",
	};
	if (!Array.isArray(value) || value.length !== run.jobs.length) return invalid;
	const results: Receipt[] = [];
	for (const [i, row] of value.entries()) {
		if (!row || typeof row !== "object" || Array.isArray(row)) return invalid;
		const { seat, conversation, answer, error } = row;
		if (
			typeof seat !== "string" ||
			seat !== run.jobs[i]?.seat ||
			typeof conversation !== "string" ||
			!conversation ||
			(answer !== null && typeof answer !== "string") ||
			(error !== null && typeof error !== "string")
		)
			return invalid;
		results.push({ seat, conversation, answer, error });
	}
	const errors = results.flatMap(({ seat, answer, error }) =>
		error !== null || !answer?.trim()
			? [`${seat}: ${error || "No answer."}`]
			: [],
	);
	return { results, error: errors.join("\n\n") || null };
}

function json(answer: string): unknown {
	try {
		return JSON.parse(answer);
	} catch {
		return null;
	}
}
function candidateValid(answer: string) {
	const sections = answer.trim().split(/^##\s+/m);
	return (
		sections[0] === "" &&
		candidateHeadings.every((heading, i) => {
			const section = sections[i + 1];
			if (!section) return false;
			const split = section.indexOf("\n");
			return (
				split > 0 &&
				section.slice(0, split).trim().toLowerCase() ===
					heading.toLowerCase() &&
				!!section.slice(split).trim()
			);
		})
	);
}
function judgeReport(answer: string) {
	const report = judgeSchema.validate(json(answer));
	return report.ok ? report.value : null;
}
function objections(answer: string) {
	const report = challengerSchema.validate(json(answer));
	return report.ok && report.value.objections.every((s) => s.trim())
		? report.value.objections
		: null;
}
function stageError(arena: Arena, stage: Run["stage"], results: Receipt[]) {
	if (stage === "candidates") {
		return (
			results
				.filter((r) => !candidateValid(r.answer!))
				.map(
					(r) =>
						`${r.seat} must supply non-empty sections in order: ${candidateHeadings.join(", ")}.`,
				)
				.join("\n\n") || null
		);
	}
	if (stage === "judge") {
		const report = judgeReport(results[0]!.answer!);
		const seats = candidateNames(arena);
		if (
			!report ||
			!seats.includes(report.base) ||
			report.scores.length !== seats.length ||
			!seats.every((seat) =>
				report.scores.some(
					(r) =>
						r.seat === seat && r.reason.trim() && r.unaskedDecisions.trim(),
				),
			)
		)
			return "The judge must name a candidate as base and give one score, reason, and account of unasked decisions for every candidate.";
		return null;
	}
	return objections(results[0]!.answer!)
		? null
		: "The challenger must submit an objections array in JSON.";
}

/** Keep attempts and child receipts even when they cannot be used to advance. */
export function settleArena(arena: Arena, fact: EffectFact) {
	const run = arena.runs.at(-1)!;
	const outcome = receipts(fact, run);
	outcome.error ??= stageError(arena, run.stage, outcome.results);
	const next = { ...arena, runs: arena.runs.with(-1, { ...run, outcome }) };
	if (outcome.error !== null)
		return { arena: next, phase: "arena_blocked" as const };
	switch (run.stage) {
		case "candidates":
			if ("error" in next.setup)
				throw new Error("Unconfigured arena has a candidate run");
			return {
				arena: plan(next, "judge", [
					{
						seat: "arena_judge",
						model: next.setup.judge,
						question: judgeQuestion({
							...next.frame,
							candidates: candidateText(next),
						}),
					},
				]),
				phase: "dispatching" as const,
			};
		case "judge":
			return { arena: next, phase: "drafting" as const };
		case "challenger":
			return { arena: next, phase: "answering" as const };
	}
}

function successful(arena: Arena, stage: Run["stage"]) {
	return arena.runs.findLast(
		(r) => r.stage === stage && r.outcome?.error === null,
	)!;
}
export function candidateNames(arena: Arena) {
	return successful(arena, "candidates").jobs.map((j) => j.seat);
}
function candidateText(arena: Arena) {
	const run = successful(arena, "candidates");
	return run
		.outcome!.results.map(
			(r, i) => `### ${r.seat} (${run.jobs[i]!.model})\n\n${r.answer}`,
		)
		.join("\n\n");
}
export function arenaEvidence(arena: Arena, number: number) {
	const run = successful(arena, "judge");
	const report = judgeReport(run.outcome!.results[0]!.answer!)!;
	const judge = [
		`Model: ${run.jobs[0]!.model}. Recommended base: ${report.base}.`,
		...report.scores.map(
			(s) =>
				`### ${s.seat}: ${s.score}/10\n\n${s.reason}\n\nUnasked decisions: ${s.unaskedDecisions}`,
		),
	].join("\n\n");
	return evidence({
		...arena.frame,
		arena: String(number),
		candidates: candidateText(arena),
		judge,
	});
}
export function synthesisSources(
	base: string,
	grafts: { seat: string; text: string }[],
) {
	return baseText({
		base,
		grafts: grafts.map((g) => `- ${g.seat}: ${g.text}`).join("\n") || "None.",
	});
}
export function startChallenger(arena: Arena, base: string, synthesis: string) {
	if ("error" in arena.setup)
		throw new Error("Unconfigured arena cannot challenge a synthesis");
	const selected = successful(arena, "candidates").outcome!.results.find(
		(r) => r.seat === base,
	)!;
	const judge = successful(arena, "judge").outcome!.results[0]!;
	return plan(arena, "challenger", [
		{
			seat: "arena_challenger",
			model: arena.setup.challenger,
			question: challengerQuestion({
				...arena.frame,
				base: `${selected.seat}\n\n${selected.answer}`,
				synthesis,
				judge: judge.answer!,
			}),
		},
	]);
}
export function challengeObjections(arena: Arena, run: number) {
	return objections(arena.runs[run - 1]!.outcome!.results[0]!.answer!)!;
}
