import { subject, type WorkId } from "../../kernel/ids.ts";
import {
	type Accepted,
	defineLane,
	type Message,
	prose,
	type Reduction,
} from "../../kernel/lane.ts";
import { defineState } from "../../kernel/state.ts";
import { queueFixture } from "./fixture.ts";
import type { Holding, Resume } from "./public.ts";

type Finding = Omit<Holding, "allow"> & {
	allow: boolean;
	status: "open" | "resumed" | "allowed" | "cancelled";
};
type FileFinding = { kind: "file" } & Holding;
type QueueState = { findings: Finding[] };

const question = prose(
	import.meta.dirname,
	"../../prose/documents/holding-finding.md",
	["goal", "scope", "evidence", "resume", "allow"],
);
const permission = prose(
	import.meta.dirname,
	"../../prose/documents/allow-publication.md",
	[],
)({});
function cancel(state: QueueState, work: WorkId): Accepted<QueueState> {
	return {
		state: {
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
const address = ({
	work,
	lane,
	cause,
}: Pick<Holding, "work" | "lane" | "cause">) =>
	subject(`finding/${work}/${lane}/${cause}`);

export const queueTools = [] as const;
export const queueLane = defineLane(
	{
		name: "queue",
		state: defineState({
			kind: "keel.queue",
			scope: "session",
			version: 1,
			initial: (): QueueState => ({ findings: [] }),
		}),
		reduce(state, event): Reduction<QueueState> {
			if (event.kind === "file") {
				const { kind: _, ...filing } = event as FileFinding;
				if (state.findings.some((f) => address(f) === address(filing)))
					return { state };
				return {
					state: {
						findings: [
							...state.findings,
							{ ...filing, allow: filing.allow === true, status: "open" },
						],
					},
				};
			}
			if (event.kind === "cancel_work")
				return cancel(state, event.work as WorkId);
			return { reject: `Unknown queue event: ${event.kind}` };
		},
		onFact(state, answer) {
			if (answer.kind !== "answered") return { state };
			const finding = state.findings.find(
				(f) => f.status === "open" && address(f) === answer.subject,
			);
			if (!finding) return { state };
			const { work, lane, item, cause, evidence } = finding;
			if (answer.choice === "cancel") return cancel(state, work);
			if (
				answer.choice !== "resume" &&
				!(answer.choice === "allow" && finding.allow)
			)
				return { state };
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
			if (answer.choice === "resume" && item !== null)
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
					findings: state.findings.map((f) =>
						f === finding
							? {
									...f,
									status: answer.choice === "allow" ? "allowed" : "resumed",
								}
							: f,
					),
				},
				send,
			};
		},
		asks: (state) =>
			state.findings
				.filter((f) => f.status === "open")
				.map((f) => {
					const basis = question({
						goal: f.goal,
						resume: f.resume,
						allow: f.allow ? permission : "",
						scope: [f.lane, f.item].filter(Boolean).join("/"),
						evidence: f.evidence,
					});
					return {
						subject: address(f),
						title: basis.split("\n", 1)[0] ?? basis,
						basis,
						choices: f.allow
							? (["allow", "resume", "cancel"] as const)
							: (["resume", "cancel"] as const),
					};
				}),
		view: (state) => ({
			openFor: (work: WorkId) =>
				state.findings.filter((f) => f.work === work && f.status === "open"),
		}),
		agents: () => [],
		effects: () => [],
	},
	queueFixture,
);
