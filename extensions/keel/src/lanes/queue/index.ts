import { effectKey, subject, type WorkId } from "../../kernel/ids.ts";
import {
	type Accepted,
	defineLane,
	type LaneEvent,
	type Message,
	prose,
	type Reduction,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import {
	type FindingDisposition,
	fileIntake,
	type Holding,
	type HoldingAddress,
	type Intake,
	type Resume,
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

type Finding = Holding & {
	status: "open" | "resumed" | "resolved" | "cancelled";
};
type FileFinding = { kind: "file" } & Holding;
type QueueState = {
	findings: Finding[];
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

const question = prose(
	import.meta.dirname,
	"../../prose/documents/holding-finding.md",
	["goal", "scope", "evidence", "resume"],
);
function cancel(state: QueueState, work: WorkId): Accepted<QueueState> {
	return {
		state: {
			...state,
			triage: triage.cancelWork(state.triage, work),
			findings: state.findings.map((f) =>
				f.work === work && f.status === "open"
					? { ...f, status: "cancelled" }
					: f,
			),
		},
		send: ["design", "build", "verify"].map((lane) => ({
			lane,
			work,
			event: { kind: "cancel" },
		})),
	};
}
const address = ({ work, lane, cause }: HoldingAddress) =>
	subject(`finding/${work}/${lane}/${cause}`);
export const queueLane = defineLane({
	name: "queue",
	state: defineState({
		kind: "keel.queue",
		scope: "session",
		version: 1,
		initial: (): QueueState => ({
			findings: [],
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
		if (event.kind === "resolve_holding") {
			const resolved = address(
				event as HoldingAddress & { kind: "resolve_holding" },
			);
			return {
				state: {
					...state,
					findings: state.findings.map((f) =>
						f.status === "open" && address(f) === resolved
							? { ...f, status: "resolved" }
							: f,
					),
				},
			};
		}
		if (event.kind === "file") {
			const { kind: _, ...filing } = event as FileFinding;
			if (state.findings.some((f) => address(f) === address(filing)))
				return { state };
			return {
				state: {
					...state,
					findings: [...state.findings, { ...filing, status: "open" }],
				},
			};
		}
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
		if (answer.kind !== "answered")
			return withTriage(state, triage.onFact(state.triage, answer, world));
		const finding = state.findings.find(
			(f) => f.status === "open" && address(f) === answer.subject,
		);
		if (!finding)
			return withTriage(state, triage.onFact(state.triage, answer, world));
		const { work, lane, item, cause, evidence } = finding;
		if (answer.choice === "cancel") return cancel(state, work);
		if (answer.choice !== "resume") return { state };
		const direction = answer.annotations
			.map((a) => `${a.n}. ${a.text}`)
			.join("\n");
		const send: Message[] = [];
		if (direction)
			send.push({
				lane: "verify",
				work,
				event: {
					kind: "finding_direction",
					lane,
					item,
					cause,
					evidence,
					direction,
				},
			});
		if (item !== null)
			send.push({
				lane: "verify",
				work,
				event: { kind: "reset_counts", item },
			});
		send.push({
			lane,
			work,
			event: {
				kind: answer.choice,
				cause,
				item,
				evidence,
				direction,
			} satisfies Resume,
		});
		return {
			state: {
				...state,
				findings: state.findings.map((f) =>
					f === finding ? { ...f, status: "resumed" } : f,
				),
			},
			send,
		};
	},
	asks: (state) => [
		...state.findings
			.filter((f) => f.status === "open")
			.map((f) => {
				const basis = question({
					goal: f.goal,
					resume: f.resume,
					scope: [f.lane, f.item].filter(Boolean).join("/"),
					evidence: f.evidence,
				});
				return {
					subject: address(f),
					title: basis.split("\n", 1)[0] ?? basis,
					basis,
					choices: ["resume", "cancel"] as const,
					works: [f.work],
				};
			}),
		...triage.asks(state.triage),
	],
	view: (state) => ({
		patternRulings: state.triage.patterns,
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
			[
				...triage.findingSummary(state.triage, work),
				...state.findings
					.filter((f) => f.work === work)
					.map(
						(f) =>
							`- Holding finding (${f.lane}${f.item ? `/${f.item}` : ""}): ${f.evidence} (${f.status})`,
					),
			].join("\n"),
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
