import { type DecisionInput, decision } from "tau";
import type { Context } from "tau/chord";
import {
	type AgentChange,
	type ConversationId,
	configure,
	defineTask,
	type JsonObject,
	LiveDoc,
	type SubmissionDraft,
	type TaskRuntime,
	type Tx,
} from "tau/durable";
import type { RoleName } from "../roles/index.ts";
import {
	type AgentKey,
	type EffectKey,
	slotKey,
	subject,
	type Token,
} from "./ids.ts";
import type { Delivery, KernelEvent, Result } from "./lane.ts";
import type { Address } from "./records.ts";
import { ledger, project } from "./storage.ts";

export type EffectInput = Address & { key: EffectKey; spec: JsonObject };
export type StopInput = Address & {
	key: AgentKey;
	conversation: ConversationId;
};
export type DeliverInput = StopInput & { token: Token; text: string };

type Hooks = {
	transact(tx: Tx, delivery: Delivery, now: number): Promise<Result>;
	roleSettings(tx: Tx, role: RoleName): Promise<AgentChange>;
	runEffect(input: EffectInput, ctx: Context): Promise<JsonObject>;
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
function draft(input: DeliverInput, attempt: Attempt): SubmissionDraft {
	// Tokens end in @sequence. The suffix keeps a nudge distinct from every first input.
	const requestId = attempt === "first" ? input.token : `${input.token}:nudge`;
	return attempt === "continue"
		? { type: "continue", requestId }
		: {
				type: "input",
				requestId,
				content: input.text,
				entry: { kind: "keel.input", data: { token: input.token } },
			};
}

export function makeTasks(hooks: Hooks) {
	// Unlike an ordinary tool refusal, rejecting a kernel fact must roll back slot consumption.
	async function apply(
		tx: Tx,
		{ lane, work }: Address,
		event: KernelEvent,
		now: number,
	) {
		const result = await hooks.transact(tx, { lane, work, event }, now);
		if ("reject" in result)
			throw new Error(`Keel refused ${event.kind}: ${result.reject}`);
	}

	const answer = defineTask<DecisionInput<string>, { phase: "apply" }, null>({
		name: "keel.answer",
		version: 1,
		initial: () => ({ phase: "apply" }),
		abort,
		phases: {
			apply: (task, runtime, ctx) =>
				runtime.commit(async (tx) => {
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
				}, ctx),
		},
	});

	const effect = defineTask<
		EffectInput,
		{ phase: "claim" } | { phase: "run"; attempt: number },
		null
	>({
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
				let event: KernelEvent;
				try {
					event = {
						kind: "effect_done",
						key: input.key,
						result: await hooks.runEffect(input, ctx),
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
				await runtime.commit(async (tx) => {
					const slot = (await ledger(tx, input.work)).effects[
						slotKey(input.lane, input.key)
					];
					if (slot?.task !== id || slot.status !== "running") return completed;
					slot.status = "done";
					await apply(tx, input, event, runtime.now());
					return completed;
				}, ctx);
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
						...(await hooks.roleSettings(tx, slot.role)),
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
				const settled = await submission.wait(ctx);
				await runtime.commit(async (tx) => {
					if (settled.reason === "aborted" || !(await openAgent(tx, input)))
						return completed;
					if (attempt === "first")
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
							lastWords,
						},
						runtime.now(),
					);
					return completed;
				}, ctx);
			},
		},
	});

	const stop = defineTask<StopInput, { phase: "stop" }, null>({
		name: "keel.stop",
		version: 1,
		initial: () => ({ phase: "stop" }),
		abort,
		phases: {
			stop: async ({ input }, runtime, ctx) => {
				const handle = await runtime.conversation(input.conversation, ctx);
				let shouldStop = false;
				await runtime.commit(async (tx) => {
					const slot = await agentSlot(tx, input);
					shouldStop = slot?.status === "paused" || slot?.status === "retired";
					return shouldStop ? undefined : completed;
				}, ctx);
				if (!shouldStop) return;
				await handle?.abort(ctx);
				await runtime.commit(() => completed, ctx);
			},
		},
	});
	return { answer, effect, deliver, stop };
}
