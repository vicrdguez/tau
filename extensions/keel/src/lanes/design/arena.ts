import { arr, compile, num, obj } from "tau/schema";
import { effectKey, subject } from "../../kernel/ids.ts";
import {
	type Ask,
	type EffectDecl,
	type KernelEvent,
	prose,
	type StaticFacts,
} from "../../kernel/lane.ts";
import { text } from "./draft.ts";
import { replyJson } from "../../reply-json.ts";

const candidateSeats = [
	"arena_seat_1",
	"arena_seat_2",
	"arena_seat_3",
] as const;
const judgeSchema = compile(
	obj({
		base: text,
		scores: arr(
			obj({
				seat: text,
				score: num({ minimum: 0, maximum: 10 }),
				reason: text,
				unaskedDecisions: arr(text),
			}),
		),
	}),
);
const challengerSchema = compile(obj({ objections: arr(text) }));

export const frameSchema = obj({ question: text, rubric: text });
type Frame = { question: string; rubric: string };
type Seat =
	| (typeof candidateSeats)[number]
	| "arena_judge"
	| "arena_challenger";
type Job = { seat: Seat; model: string; question: string };
type Receipt = {
	seat: Seat;
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
	judge: string;
	challenger: string;
	refusal: string | null;
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
	"sources",
	"experiments",
	"candidates",
	"judge",
]);
const blocked = prose(dir, "documents/arena-blocked.md", ["error", "seats"]);

const modelFor = (seat: Seat, options: StaticFacts["options"]) =>
	options[seat] ?? options.design;
function familyError(
	candidates: Job[],
	judge: string | null,
	options: StaticFacts["options"],
	retry?: Job[],
) {
	const provider = (model: string) => model.split("/", 1)[0];
	const problems: string[] = [];
	for (const candidate of candidates) {
		const family = provider(candidate.model);
		const matches = candidates.filter(
			({ model }) => provider(model) === family,
		);
		if (matches.length < 2 || matches[0] !== candidate) continue;
		const changeable = retry
			? matches.filter((job) => retry.some(({ seat }) => seat === job.seat))
			: matches;
		if (!changeable.length) continue;
		const seats = changeable.map(({ seat }) => `\`${seat}\``).join(", ");
		problems.push(
			changeable.length === matches.length
				? `Set ${seats} to different providers (currently \`${family}\`).`
				: `Set ${seats} to ${changeable.length === 1 ? "a different provider from" : "distinct providers other than"} \`${family}\`.`,
		);
	}
	const designerFamily = provider(options.designer ?? options.design);
	if (judge && provider(judge) === designerFamily)
		problems.push(
			retry
				? `Set \`arena_judge\` to a different provider from \`${designerFamily}\`.`
				: "Set `arena_judge` to a different provider from the `designer` model (which defaults to `design`).",
		);
	return problems.length
		? [
				"Keel treats the provider in `provider/modelId` as the model family.",
				...problems,
			].join("\n\n")
		: null;
}
function plan(arena: Arena, stage: Run["stage"], jobs: Job[]): Arena {
	return {
		...arena,
		refusal: null,
		runs: [...arena.runs, { stage, jobs, outcome: null }],
	};
}
const dispatch = (arena: Arena) => ({ phase: "dispatching" as const, arena });
const refuse = (arena: Arena, refusal: string) => ({
	phase: "arena_blocked" as const,
	arena: { ...arena, refusal },
});
export function startArena(
	frame: Frame,
	ground: string,
	seed: string,
	{ options }: StaticFacts,
) {
	const judge = modelFor("arena_judge", options);
	const arena: Arena = {
		frame,
		judge,
		challenger: modelFor("arena_challenger", options),
		refusal: null,
		runs: [],
		forcedBase: null,
	};
	const question = candidateQuestion({ ...frame, ground, seed });
	const jobs = (
		options.arena_seat_3 ? candidateSeats : candidateSeats.slice(0, 2)
	).map((seat) => ({ seat, model: modelFor(seat, options), question }));
	const error = familyError(jobs, judge, options);
	return error
		? refuse(arena, error)
		: dispatch(plan(arena, "candidates", jobs));
}

function candidateJobs(arena: Arena) {
	const latest = new Map<Seat, Job>();
	for (const run of arena.runs)
		if (run.stage === "candidates")
			for (const job of run.jobs) latest.set(job.seat, job);
	return [...latest.values()];
}
function failedJobs(run: Run) {
	return run.jobs.filter(
		({ seat }) =>
			!run.outcome?.results.some((r) => r.seat === seat && r.error === null),
	);
}
export function retryArena(
	arena: Arena,
	ground: string,
	seed: string,
	w: StaticFacts,
) {
	const run = arena.runs.at(-1);
	if (!run) return startArena(arena.frame, ground, seed, w);
	const jobs = failedJobs(run).map((job) => ({
		...job,
		model: modelFor(job.seat, w.options),
	}));
	const error = familyError(
		run.stage === "candidates"
			? candidateJobs(arena).map(
					(job) => jobs.find(({ seat }) => job.seat === seat) ?? job,
				)
			: [],
		run.stage === "judge" ? jobs[0]!.model : null,
		w.options,
		jobs,
	);
	return error ? refuse(arena, error) : dispatch(plan(arena, run.stage, jobs));
}
export function blockedAsk(arena: Arena, seq: number): Ask {
	const run = arena.runs.at(-1);
	return {
		subject: subject(`arena/failure/${seq}`),
		title: "Retry the arena or decline the work?",
		basis: blocked({
			error: arena.refusal ?? run!.outcome!.error!,
			seats: run
				? failedJobs(run)
						.map(({ seat }) => `\`${seat}\``)
						.join(", ")
				: "all configured seats",
		}),
		choices: ["retry", "decline"],
	};
}

export function arenaEffect(arena: Arena, number: number): EffectDecl {
	const { stage, jobs } = arena.runs.at(-1)!;
	return {
		key: effectKey(`arena/${number}/${stage}/${arena.runs.length}`),
		interruptible: true,
		spec: { kind: "arena_dispatch", jobs },
	};
}

type EffectFact = Extract<
	KernelEvent,
	{ kind: "effect_done" | "effect_failed" }
>;
function receipts(fact: EffectFact, run: Run): Receipt[] | string {
	if (fact.kind === "effect_failed") return fact.error;
	const rows = fact.result.results;
	const invalid =
		"The dispatch result does not match the planned seats in order.";
	if (!Array.isArray(rows) || rows.length !== run.jobs.length) return invalid;
	const results: Receipt[] = [];
	for (const [i, row] of rows.entries()) {
		if (!row || typeof row !== "object" || Array.isArray(row)) return invalid;
		const { seat, conversation, answer, error } = row;
		const job = run.jobs[i]!;
		if (
			seat !== job.seat ||
			typeof conversation !== "string" ||
			!conversation ||
			(answer !== null && typeof answer !== "string") ||
			(error !== null && typeof error !== "string")
		)
			return invalid;
		results.push({ seat: job.seat, conversation, answer, error });
	}
	return results;
}

function unaskedText(answer: string) {
	const heading =
		/^ {0,3}(#{1,6})[ \t]+Unasked decisions[ \t]*(?:#+[ \t]*)?\r?\n/im.exec(
			answer,
		);
	if (!heading) return "";
	const next = new RegExp(`^ {0,3}#{1,${heading[1]!.length}}[ \\t]+`, "m");
	return answer
		.slice(heading.index + heading[0].length)
		.split(next, 1)[0]!
		.trim();
}
function judgeReport(answer: string) {
	const report = judgeSchema.validate(replyJson(answer));
	return report.ok ? report.value : null;
}
function objections(answer: string) {
	const report = challengerSchema.validate(replyJson(answer));
	return report.ok && report.value.objections.every((s) => s.trim())
		? report.value.objections
		: null;
}
function formatError(arena: Arena, stage: Run["stage"], answer: string) {
	if (stage === "candidates")
		return unaskedText(answer)
			? null
			: "Supply a non-empty Unasked Decisions section.";
	if (stage === "challenger")
		return objections(answer) ? null : "Submit an objections array in JSON.";
	const report = judgeReport(answer);
	const seats = candidateNames(arena);
	if (
		!report ||
		!seats.some((seat) => seat === report.base) ||
		report.scores.length !== seats.length ||
		!seats.every((seat) =>
			report.scores.some(
				(r) =>
					r.seat === seat &&
					r.reason.trim() &&
					r.unaskedDecisions.every((decision) => decision.trim()),
			),
		)
	)
		return "Name a candidate as base and give one score, reason, and list of unasked decisions for every candidate.";
	return null;
}

/** Keep attempts and child receipts even when they cannot be used to advance. */
export function settleArena(arena: Arena, fact: EffectFact) {
	const run = arena.runs.at(-1)!;
	const returned = receipts(fact, run);
	const results =
		typeof returned === "string"
			? []
			: returned.map((r) => ({
					...r,
					error:
						r.error ??
						(r.answer?.trim()
							? formatError(arena, run.stage, r.answer)
							: "No answer."),
				}));
	const error =
		typeof returned === "string"
			? returned
			: results
					.flatMap((r) => (r.error === null ? [] : [`${r.seat}: ${r.error}`]))
					.join("\n\n") || null;
	const next = {
		...arena,
		runs: arena.runs.with(-1, { ...run, outcome: { results, error } }),
	};
	if (error !== null) return { arena: next, phase: "arena_blocked" as const };
	switch (run.stage) {
		case "candidates":
			return dispatch(
				plan(next, "judge", [
					{
						seat: "arena_judge",
						model: next.judge,
						question: judgeQuestion({
							...next.frame,
							candidates: candidateNames(next)
								.map((seat) => `### ${seat}\n\n${candidateAnswer(next, seat)}`)
								.join("\n\n"),
						}),
					},
				]),
			);
		case "judge":
			return {
				arena: next,
				phase: "drafting" as const,
			};
		case "challenger":
			return { arena: next, phase: "answering" as const };
	}
}

export function candidateNames(arena: Arena) {
	return candidateJobs(arena).map((j) => j.seat);
}
function candidateAnswer(arena: Arena, seat: string) {
	return arena.runs
		.findLast(
			(r) =>
				r.stage === "candidates" &&
				r.outcome?.results.some(
					(row) => row.seat === seat && row.error === null,
				),
		)!
		.outcome!.results.find((row) => row.seat === seat && row.error === null)!
		.answer!;
}
function judging(arena: Arena) {
	return arena.runs.findLast(
		(r) => r.stage === "judge" && r.outcome?.error === null,
	)!;
}
export function candidateDecisions(arena: Arena, seat: string) {
	const score = judgeReport(
		judging(arena).outcome!.results[0]!.answer!,
	)!.scores.find((row) => row.seat === seat)!;
	return {
		decisions: score.unaskedDecisions,
		own: unaskedText(candidateAnswer(arena, seat)),
	};
}
export const quote = (text: string) =>
	text
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
export function arenaEvidence(
	arena: Arena,
	number: number,
	sources = "",
	experiments = "None.",
) {
	const run = judging(arena);
	const report = judgeReport(run.outcome!.results[0]!.answer!)!;
	return evidence({
		...arena.frame,
		arena: String(number),
		sources,
		experiments,
		judge: [
			`Model: ${run.jobs[0]!.model}. Recommended base: ${report.base}.`,
			...report.scores.map(
				(s) =>
					`#### ${s.seat}: ${s.score}/10\n\n${quote(s.reason)}\n\nUnasked decisions:\n\n${s.unaskedDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n") || "None."}`,
			),
		].join("\n\n"),
		candidates: candidateJobs(arena)
			.map(
				({ seat, model }) =>
					`#### ${seat} (${model})\n\n${quote(candidateAnswer(arena, seat))}`,
			)
			.join("\n\n"),
	});
}
export function startChallenger(arena: Arena, base: string, synthesis: string) {
	return plan(arena, "challenger", [
		{
			seat: "arena_challenger",
			model: arena.challenger,
			question: challengerQuestion({
				...arena.frame,
				base: `${base}\n\n${quote(candidateAnswer(arena, base))}`,
				synthesis: quote(synthesis),
				judge: quote(judging(arena).outcome!.results[0]!.answer!),
			}),
		},
	]);
}
export function challengeObjections(arena: Arena, run: number) {
	return objections(arena.runs[run - 1]!.outcome!.results[0]!.answer!)!;
}
