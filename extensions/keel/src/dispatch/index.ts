import { role } from "tau";
import type { Context } from "tau/chord";
import {
	type AgentChange,
	type ConversationId,
	defineDoc,
	defineTool,
	type Extension,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "tau/durable";
import { arr, obj, str } from "tau/schema";

const MAX_JOBS = 8;
export const DEFAULT_DISPATCH_MINUTES = 20;
export const DEFAULT_DISPATCH_ROUNDS = 64;
const TOOL = "dispatch";

export type DispatchJob = { seat: string; question: string };
export type DispatchResult = {
	seat: string;
	conversation: ConversationId;
	answer: string | null;
	error: string | null;
};
type Seat = AgentChange & {
	model: NonNullable<AgentChange["model"]>;
	extensions: readonly Extension[];
	tools: readonly ToolRegistration[];
	instructions: string;
};
type DispatchOwner = Pick<
	ToolExecutionApi,
	"taskId" | "conversationId" | "commit" | "conversation" | "now"
>;
export type DispatchRoster<J extends DispatchJob = DispatchJob> = {
	timeoutMs?: number | undefined;
	maxTurns?: number;
	resolve(
		tx: Tx,
		caller: ConversationId,
		job: J,
		index: number,
	): Seat | undefined | Promise<Seat | undefined>;
};

export type DispatchAdmission<J extends DispatchJob> =
	| DispatchRoster<J>
	| ((tx: Tx, caller: ConversationId) => Promise<DispatchRoster<J>>);

type Plan = {
	deadline: number;
	jobs: (DispatchJob & { conversation: ConversationId })[];
};
const planDoc = defineDoc<Plan>({
	kind: "dispatch.plan",
	scope: "task",
	version: 1,
	initial: () => ({ deadline: 0, jobs: [] }),
	checkpointWhen: () => false,
});

/** One foreground batch per owner task. The plan pins ordering and child IDs in the creation commit. */
export async function fanOut<J extends DispatchJob>(
	owner: DispatchOwner,
	admit: DispatchAdmission<J>,
	jobs: readonly J[],
	ctx: Context,
	onChildren?: (ids: ConversationId[], ctx: Context) => Promise<void>,
): Promise<DispatchResult[]> {
	if (
		jobs.length < 1 ||
		jobs.length > MAX_JOBS ||
		jobs.some((j) => !j.seat.trim() || !j.question.trim())
	)
		throw new Error(
			`Give 1 to ${MAX_JOBS} dispatch jobs with a seat and a question.`,
		);
	const plan = await owner.commit(async (tx): Promise<Plan> => {
		const caller = await tx.conversation(owner.conversationId);
		if (!caller || caller.owner)
			throw new Error("A child conversation cannot dispatch.");
		const roster =
			typeof admit === "function"
				? await admit(tx, owner.conversationId)
				: admit;
		const stored = await tx.doc(planDoc, owner.taskId);
		if (stored.jobs.length) {
			if (
				stored.jobs.length !== jobs.length ||
				stored.jobs.some(
					({ seat, question }, i) =>
						seat !== jobs[i]?.seat || question !== jobs[i]?.question,
				)
			)
				throw new Error("This task already owns a different dispatch batch.");
			return {
				deadline: stored.deadline,
				jobs: stored.jobs.map((job) => ({ ...job })),
			};
		}
		const timeoutMs = roster.timeoutMs ?? DEFAULT_DISPATCH_MINUTES * 60_000;
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > 2147483647
		)
			throw new Error("Dispatch needs a positive timeout in milliseconds.");
		// Resolve the whole permitted roster before making any table writes.
		const seats: Seat[] = [];
		for (const [index, job] of jobs.entries()) {
			const seat = await roster.resolve(tx, owner.conversationId, job, index);
			if (!seat) throw new Error(`Dispatch seat not available: ${job.seat}`);
			if (seat.tools.some(({ name }) => name === TOOL))
				throw new Error("Dispatch seats cannot have the dispatch tool.");
			seats.push(seat);
		}
		const plan: Plan = { deadline: owner.now() + timeoutMs, jobs: [] };
		for (const [i, { seat, question }] of jobs.entries()) {
			const conversation = await role(
				tx,
				{
					...seats[i]!,
					// Do not inherit a narrower filter or limits from the caller.
					modelTools: null,
					maxTurns:
						seats[i]!.maxTurns ?? roster.maxTurns ?? DEFAULT_DISPATCH_ROUNDS,
					thinkingLevel: seats[i]!.thinkingLevel ?? null,
					compaction: { enabled: false },
				},
				{ kind: "task", taskId: owner.taskId },
			);
			plan.jobs.push({ seat, question, conversation });
		}
		Object.assign(stored, plan);
		return plan;
	}, ctx);
	await onChildren?.(
		plan.jobs.map(({ conversation }) => conversation),
		ctx,
	);
	const timeout = AbortSignal.timeout(Math.max(0, plan.deadline - owner.now()));
	const waiting: Context = {
		abortSignal: ctx.abortSignal
			? AbortSignal.any([ctx.abortSignal, timeout])
			: timeout,
		telemetry: ctx.telemetry,
		value: ctx.value.bind(ctx),
		toString: ctx.toString.bind(ctx),
	};
	return Promise.all(
		plan.jobs.map(
			async ({ seat, question, conversation }, i): Promise<DispatchResult> => {
				const failure = (error: string) => ({
					seat,
					conversation,
					answer: null,
					error,
				});
				const handle = await owner.conversation(conversation, ctx);
				if (!handle) throw new Error(`Missing dispatch child ${conversation}`);
				const requestId = `dispatch:${owner.taskId}:${i}`;
				const expired = async () => {
					const current = await owner.commit(
						(tx) => tx.submissionByRequest(conversation, requestId),
						ctx,
					);
					if (current?.status === "done") return current;
					await handle.abort(ctx);
					return null;
				};
				const settled =
					owner.now() >= plan.deadline
						? await expired()
						: await (
								await handle.submit(
									{
										type: "input",
										content: question,
										requestId,
										whenBusy: "reject",
									},
									ctx,
								)
							)
								.wait(waiting)
								.catch((error: unknown) => {
									ctx.abortSignal?.throwIfAborted();
									if (!timeout.aborted) throw error;
									return expired();
								});
				if (!settled) return failure("Dispatch child timed out.");
				if (settled.status === "unanswered") return failure(settled.reason);
				const entryId = settled.answer;
				const answer =
					entryId === undefined
						? ""
						: await owner.commit(
								async (tx) =>
									(await tx.entry(entryId))?.model
										?.flatMap((message) =>
											message.role === "assistant"
												? message.content.flatMap((part) =>
														part.type === "text" ? [part.text] : [],
													)
												: [],
										)
										.join("\n") ?? "",
								ctx,
							);
				return answer.trim()
					? { seat, conversation, answer, error: null }
					: failure("Dispatch child returned no text answer.");
			},
		),
	);
}

export function dispatchTool(roster: DispatchAdmission<DispatchJob>) {
	return defineTool({
		name: TOOL,
		description: `Give up to ${MAX_JOBS} independent questions to available seats. Join their answers or failures in the same order.`,
		parameters: obj({
			jobs: arr(
				obj({ seat: str({ minLength: 1 }), question: str({ minLength: 1 }) }),
				{ minItems: 1, maxItems: MAX_JOBS },
			),
		}),
		callers: ["model"],
		replay: "safe",
		executionMode: "sequential",
		async execute({ jobs }, api, ctx) {
			const results = await fanOut(
				api,
				roster,
				jobs,
				ctx,
				(children, context) => api.details({ children }, context),
			);
			return { output: [{ type: "text", text: JSON.stringify(results) }] };
		},
	});
}
