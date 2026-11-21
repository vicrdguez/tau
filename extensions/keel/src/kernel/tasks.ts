import { type DecisionInput, decision, emit } from "tau";
import type { Context } from "tau/chord";
import {
	type AgentChange,
	type ConversationId,
	type Cursor,
	configure,
	defineEntry,
	defineTask,
	type JsonObject,
	LiveDoc,
	type SubmissionDraft,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "tau/durable";
import {
	type DispatchJob,
	type DispatchResult,
	type DispatchRoster,
	fanOut,
} from "../dispatch/index.ts";
import { type RoleName, storedRole } from "../roles/index.ts";
import {
	type AgentKey,
	type EffectKey,
	slotKey,
	subject,
	type Token,
} from "./ids.ts";
import type { FactDelivery, KernelEvent, Result } from "./lane.ts";
import { type Address, ProjectState, WorkState } from "./records.ts";
import { RejectedSeed } from "./routing.ts";
import { stateDoc } from "./state.ts";
import { ledger, project } from "./storage.ts";

export type EffectInput = Address & {
	key: EffectKey;
	spec: JsonObject;
	root: string;
};
export type StopInput = Address & {
	key: AgentKey;
	conversation: ConversationId;
};
export type DeliverInput = StopInput & {
	token: Token;
	text: string;
	data?: JsonObject;
};

type EffectPhase = { phase: "claim" } | { phase: "run"; attempt: number };
/** Effect code can create and recover its owned conversations, but never advance the task. */
type EffectOwner = {
	scanChildren(
		limit: number,
		cursor?: Cursor,
	): ReturnType<Tx["scanConversations"]>;
	createChild(): Promise<ConversationId>;
	dispatch<J extends DispatchJob>(
		roster: DispatchRoster<J>,
		jobs: readonly J[],
		context: Context,
	): Promise<DispatchResult[]>;
};
export type EffectRunner = (
	input: EffectInput,
	ctx: Context,
	owner: EffectOwner,
) => Promise<JsonObject>;

type Hooks = {
	transact(tx: Tx, delivery: FactDelivery, now: number): Promise<Result>;
	roleSettings(tx: Tx, role: RoleName): Promise<AgentChange>;
	runEffect: EffectRunner;
};

const completed = {
	status: "terminal",
	outcome: { status: "completed", result: null },
} as const;
function abort<I, S>(
	_task: unknown,
	runtime: TaskRuntime<I, S, null, object>,
	ctx: Context,
) {
	return runtime.commit(
		() => ({ status: "terminal", outcome: { status: "aborted" } }),
		ctx,
	);
}

async function agentSlot(tx: Tx, input: StopInput) {
	const slot = (await ledger(tx, input.work)).agents[
		slotKey(input.lane, input.key)
	];
	return slot?.conversation === input.conversation ? slot : undefined;
}

async function openAgent(tx: Tx, input: DeliverInput) {
	const slot = await agentSlot(tx, input);
	return slot?.status === "active" &&
		slot.open.some((expect) => expect.token === input.token)
		? slot
		: undefined;
}

type Attempt = "first" | "repeat" | "continue";
type Watch = { phase: "watch"; attempt: Attempt };
type Send = { phase: "submit"; attempt: Attempt };
function draft(
	input: DeliverInput,
	attempt: Attempt,
): SubmissionDraft & { requestId: string } {
	// Tokens end in @sequence. The suffix keeps a nudge distinct from every first input.
	const requestId = attempt === "first" ? input.token : `${input.token}:nudge`;
	return attempt === "continue"
		? { type: "continue", requestId }
		: {
				type: "input",
				requestId,
				content: input.text,
				entry: {
					kind: "keel.input",
					data: { ...input.data, token: input.token },
				},
			};
}

export function makeTasks(hooks: Hooks) {
	const refusedFact = defineEntry<{
		text: string;
		at: number;
		conversation?: ConversationId;
	}>("keel.event");
	async function refused(
		tx: Tx,
		{ lane, work }: Address,
		event: KernelEvent,
		now: number,
		reason: string,
	) {
		await emit(tx, refusedFact, {
			text: `Could not route a follow-up to ${lane} fact ${JSON.stringify(event)}: ${reason}`,
			at: now,
			...(work !== null && { conversation: work }),
		});
	}
	async function recordFact(
		tx: Tx,
		address: Address,
		event: KernelEvent,
		now: number,
	) {
		const result = await hooks.transact(tx, { ...address, fact: event }, now);
		if ("reject" in result)
			await refused(tx, address, event, now, result.reject);
	}
	// A rejected chain that allocated a conversation has to roll back. In a
	// fresh commit check the original slot again and record the fact/refusal
	// instead; never repeat the external effect or leave its slot running.
	async function commitFact<I, S>(
		runtime: TaskRuntime<I, S, null, object>,
		change: (
			tx: Tx,
			apply: typeof recordFact,
		) => ReturnType<Parameters<typeof runtime.commit>[0]>,
		ctx: Context,
	) {
		try {
			await runtime.commit((tx) => change(tx, recordFact), ctx);
		} catch (error) {
			if (!(error instanceof RejectedSeed)) throw error;
			await runtime.commit(
				(tx) =>
					change(tx, (tx, address, event, now) =>
						refused(tx, address, event, now, error.message),
					),
				ctx,
			);
		}
	}

	const answer = defineTask<DecisionInput<string>, { phase: "apply" }, null>({
		name: "keel.answer",
		version: 1,
		initial: () => ({ phase: "apply" }),
		abort,
		phases: {
			apply: (task, runtime, ctx) =>
				commitFact(
					runtime,
					async (tx, apply) => {
						const d = await decision(tx, task.input.decision);
						if (
							d?.status !== "answered" ||
							d.choice !== task.input.choice ||
							d.conversation !== runtime.conversationId
						)
							return completed;
						const { asks } = await project(tx);
						const slot = asks[d.subject];
						if (slot?.decision !== d.id) return completed;
						const { lane, work, local } = slot;
						delete asks[d.subject];
						await apply(
							tx,
							{ lane, work },
							{
								kind: "answered",
								subject: subject(local),
								decision: d.id,
								choice: d.choice,
								annotations: d.annotations.map((note, i) => ({
									...note,
									n: i + 1,
								})),
							},
							runtime.now(),
						);
						return completed;
					},
					ctx,
				),
		},
	});

	const effect = defineTask<EffectInput, EffectPhase, null>({
		name: "keel.effect",
		version: 1,
		initial: () => ({ phase: "claim" }),
		abort,
		phases: {
			claim: ({ input, id }, runtime, ctx) =>
				runtime.commit(async (tx) => {
					const slot = (await ledger(tx, input.work)).effects[
						slotKey(input.lane, input.key)
					];
					if (slot?.task !== id || slot.status !== "planned") return completed;
					slot.status = "running";
					return {
						status: "running",
						checkpoint: { phase: "run", attempt: 1 },
					};
				}, ctx),
			run: async ({ input, id, state }, runtime, ctx) => {
				const { attempt } = state.checkpoint;
				async function readOrCreate<T>(
					operation: (tx: Tx) => T | Promise<T>,
					context = ctx,
				): Promise<T> {
					let value!: T;
					await runtime.commit(async (tx) => {
						value = await operation(tx);
						return undefined;
					}, context);
					return value;
				}
				let event: KernelEvent;
				try {
					event = {
						kind: "effect_done",
						key: input.key,
						result: await hooks.runEffect(input, ctx, {
							dispatch: (roster, jobs, context) =>
								fanOut(
									{
										taskId: id,
										conversationId: runtime.conversationId,
										now: () => runtime.now(),
										commit: readOrCreate,
										conversation: (child, context) =>
											runtime.conversation(child, context),
									},
									roster,
									jobs,
									context,
								),
							scanChildren: (limit, cursor) =>
								readOrCreate((tx) =>
									tx.scanConversations({ ownerTaskId: id }, limit, cursor),
								),
							createChild: () =>
								readOrCreate(
									async (tx) =>
										(
											await tx.createConversation({
												ownership: { kind: "task", taskId: id },
											})
										).id,
								),
						}),
					};
				} catch (error) {
					if (attempt < 3)
						return runtime.sleepUntil(
							runtime.now() + 100 * 2 ** (attempt - 1),
							{ phase: "run", attempt: attempt + 1 },
							ctx,
						);
					event = {
						kind: "effect_failed",
						key: input.key,
						error: error instanceof Error ? error.message : String(error),
					};
				}
				await commitFact(
					runtime,
					async (tx, apply) => {
						const slot = (await ledger(tx, input.work)).effects[
							slotKey(input.lane, input.key)
						];
						if (slot?.task !== id || slot.status !== "running")
							return completed;
						slot.status = "done";
						await apply(tx, input, event, runtime.now());
						return completed;
					},
					ctx,
				);
			},
		},
	});

	const deliver = defineTask<DeliverInput, Send | Watch, null>({
		name: "keel.deliver",
		version: 1,
		initial: () => ({ phase: "submit", attempt: "first" }),
		abort,
		phases: {
			submit: async ({ input, state }, runtime, ctx) => {
				const handle = await runtime.conversation(input.conversation, ctx);
				if (!handle)
					throw new Error(`Missing Keel conversation ${input.conversation}`);
				await runtime.commit(async (tx) => {
					const slot = await openAgent(tx, input);
					if (!slot) return completed;
					await configure(tx, input.conversation, {
						...(await hooks.roleSettings(tx, storedRole(slot.role))),
						cwd: slot.cwd,
					});
					let { attempt } = state.checkpoint;
					// Another run can start after settlement. A continue cannot queue; repeat the tagged input instead.
					if (
						attempt === "continue" &&
						(await tx.doc(LiveDoc, input.conversation)).run
					)
						attempt = "repeat";
					await handle.submit(tx, draft(input, attempt));
					return { status: "running", checkpoint: { phase: "watch", attempt } };
				}, ctx);
			},
			watch: async ({ input, state }, runtime, ctx) => {
				const { attempt } = state.checkpoint;
				const handle = await runtime.conversation(input.conversation, ctx);
				if (!handle)
					throw new Error(`Missing Keel conversation ${input.conversation}`);
				// submit + watch checkpoint were atomic. This only reacquires the admitted submission.
				const submission = await handle.submit(draft(input, attempt), ctx);
				// A failed run can leave follow-ups queued forever. Wait for the
				// blocking generation, not merely for placement of the follow-up.
				while ((await submission.status(ctx)).status === "queued") {
					let blocker: TaskId | undefined;
					let stranded = false;
					await commitFact(
						runtime,
						async (tx, apply) => {
							if ((await tx.submission(submission.id))?.status !== "queued")
								return;
							blocker = (await tx.doc(LiveDoc, input.conversation)).run?.taskId;
							if (blocker !== undefined) return;
							stranded = true;
							if (!(await openAgent(tx, input))) return completed;
							if (attempt === "first") {
								await handle.submit(tx, draft(input, "continue"));
								return {
									status: "running",
									checkpoint: { phase: "watch", attempt: "continue" },
								};
							}
							await apply(
								tx,
								input,
								{
									kind: "agent_stalled",
									agent: input.key,
									tokens: [input.token],
									cause: "failed",
									lastWords: "",
								},
								runtime.now(),
							);
							return completed;
						},
						ctx,
					);
					if (stranded) return;
					if (blocker !== undefined) await runtime.waitForTask(blocker, ctx);
				}
				const settled = await submission.wait(ctx);
				await commitFact(
					runtime,
					async (tx, apply) => {
						if (!(await openAgent(tx, input))) return completed;
						if (attempt === "first" && settled.reason !== "aborted")
							return {
								status: "running",
								checkpoint: {
									phase: "submit",
									attempt:
										settled.status === "unanswered" ? "continue" : "repeat",
								},
							};
						const answer =
							settled.answer === undefined
								? undefined
								: await tx.entry(settled.answer);
						const lastWords =
							answer?.model
								?.flatMap((m) =>
									m.role === "assistant"
										? m.content.flatMap((part) =>
												part.type === "text" ? [part.text] : [],
											)
										: [],
								)
								.join("\n") ?? "";
						await apply(
							tx,
							input,
							{
								kind: "agent_stalled",
								agent: input.key,
								tokens: [input.token],
								cause:
									settled.reason === "aborted"
										? "stopped"
										: settled.status === "unanswered"
											? "failed"
											: "unfulfilled",
								lastWords,
							},
							runtime.now(),
						);
						return completed;
					},
					ctx,
				);
			},
		},
	});

	const stop = defineTask<StopInput, { phase: "stop" }, null>({
		name: "keel.stop",
		version: 1,
		initial: () => ({ phase: "stop" }),
		abort,
		phases: {
			stop: async ({ input, id }, runtime, ctx) => {
				const handle = await runtime.conversation(input.conversation, ctx);
				// The last read before abort checks this exact stop intent, not just inactivity.
				const slots =
					input.work === null
						? (await runtime.snapshot(stateDoc(ProjectState), ctx))?.ledger
						: await runtime.snapshot(stateDoc(WorkState), input.work, ctx);
				const slot = slots?.agents[slotKey(input.lane, input.key)];
				if (
					slot?.stop === id &&
					slot.status !== "active" &&
					slot.conversation === input.conversation
				)
					await handle?.abort(ctx);
				await runtime.commit(() => completed, ctx);
			},
		},
	});
	return { answer, effect, deliver, stop };
}
