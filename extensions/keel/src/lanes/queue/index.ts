import { effectKey, type WorkId } from "../../kernel/ids.ts";
import {
	type Accepted,
	defineLane,
	type Reduction,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import {
	type FindingDisposition,
	fileIntake,
	type Intake,
	type SweepFinding,
} from "./public.ts";
import {
	disposition,
	type Investigated,
	initial,
	pending,
	type Queue,
} from "./state.ts";
import * as triage from "./triage.ts";

export { queueTools } from "./tools.ts";

type QueueState = {
	triage: Queue;
	sweepMinutes: number | null;
	sweepTick: number;
};
const sweepKey = (state: QueueState) => effectKey(`sweep/${state.sweepTick}`);
const withTriage = (
	state: QueueState,
	result: Accepted<Queue>,
): Accepted<QueueState> => {
	const next = pending(result.state)?.id;
	const changed = next !== pending(state.triage)?.id;
	// Route the new head separately so its work is loaded, not the preceding investigation’s.
	return {
		...result,
		state: {
			...state,
			triage:
				changed && next == null
					? { ...result.state, context: "", direction: "" }
					: result.state,
		},
		...(changed &&
			next != null && {
				send: [
					...(result.send ?? []),
					{ lane: "queue", work: null, event: { kind: "begin_investigation" } },
				],
			}),
	};
};

function cancel(state: QueueState, work: WorkId): Accepted<QueueState> {
	return {
		state: {
			...state,
			triage: triage.cancelWork(state.triage, work),
		},
		send: ["design", "build", "verify"].map((lane) => ({
			lane,
			work,
			event: { kind: "cancel" },
		})),
	};
}
export const queueLane = defineLane({
	name: "queue",
	state: defineState({
		kind: "keel.queue",
		scope: "session",
		version: 1,
		initial: (): QueueState => ({
			triage: initial(),
			sweepMinutes: null,
			sweepTick: 0,
		}),
	}),
	workInHand: (state, event) => triage.workFor(state.triage, event),
	reduce(state, event, world): Reduction<QueueState> {
		if (event.kind === "sweep_configured") {
			const sweepMinutes = world.options.sweep_minutes ?? null;
			return {
				state:
					sweepMinutes === state.sweepMinutes
						? state
						: {
								...state,
								sweepMinutes,
								sweepTick: (state.sweepTick ?? 0) + 1,
							},
			};
		}
		if (event.kind === "begin_investigation")
			return withTriage(state, { state: triage.begin(state.triage, world) });
		if (event.kind === "intake" || event.kind === "investigated") {
			const result =
				event.kind === "intake"
					? triage.intake(
							state.triage,
							event as Intake & { kind: "intake" },
							world,
						)
					: triage.classify(state.triage, event as Investigated, world);
			return result.reject === undefined
				? withTriage(state, result)
				: { reject: result.reject };
		}
		if (event.kind === "revision_disposition")
			return withTriage(state, {
				state: triage.recordDisposition(
					state.triage,
					event as FindingDisposition,
				),
			});
		if (event.kind === "cancel_work")
			return cancel(state, event.work as WorkId);
		return { reject: `Unknown queue event: ${event.kind}` };
	},
	onFact(state, answer, world): Accepted<QueueState> {
		if (
			"key" in answer &&
			state.sweepMinutes &&
			answer.key === sweepKey(state)
		) {
			const findings =
				answer.kind === "effect_done"
					? (answer.result.findings as SweepFinding[])
					: [];
			return {
				state: {
					...state,
					sweepTick: state.sweepTick + 1,
				},
				send: findings.map((f) =>
					fileIntake({
						work: null,
						source: "sweeper",
						item: null,
						sha: null,
						text: f.text,
						report: f.report,
						nodes: [],
						edgeCase: null,
						pattern: f.pattern ?? null,
						blocking: false,
						...(f.principle && { principle: true }),
					}),
				),
				...(answer.kind === "effect_failed" && {
					notes: [
						{
							agent: null,
							text: `Sweep failed; the next tick is still scheduled. ${answer.error}`,
						},
					],
				}),
			};
		}
		return withTriage(state, triage.onFact(state.triage, answer, world));
	},
	asks: (state) => triage.asks(state.triage),
	view: (state) => ({
		patternRulings: triage.patternRulings(state.triage),
		priorFindings: state.triage.entries.flatMap((f) =>
			f.intake.source === "sweeper"
				? [
						{
							id: f.id,
							text: f.intake.text,
							report: f.intake.report,
							disposition: disposition(f),
						},
					]
				: [],
		),
		investigation: pending(state.triage) ? state.triage.context : null,
		directionsFor: (work: WorkId) =>
			state.triage.entries.flatMap((f) =>
				f.intake.work === work && f.triageDirection
					? [`Triage finding #${f.id}: ${f.intake.text}\n${f.triageDirection}`]
					: [],
			),
		findingsFor: (work: WorkId) =>
			triage.findingSummary(state.triage, work).join("\n"),
	}),
	agents: (state) => triage.agents(state.triage),
	effects: (state) =>
		state.sweepMinutes
			? [
					{
						key: sweepKey(state),
						interruptible: true,
						delayMs: state.sweepMinutes * 60_000,
						spec: { kind: "sweep" },
					},
				]
			: [],
});
