// Open the real Keel kernel with scripted model turns and caller-supplied storage.
// Guest inputs and effect receipts are explicit; this driver never predicts lane outcomes.
import assert from "node:assert/strict";
import { type Annotation, type DecisionId, decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	Codemode,
	CodingTools,
	createRegistry,
	type JsonObject,
	NodeExecutionEnv,
	type Storage,
	type Tx,
} from "tau/durable";
import {
	createModels,
	type FauxResponseStep,
	fauxAnswer,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	openStore,
} from "tau/testing";
import { effectKey, workId } from "../../src/kernel/ids.ts";
import type { KernelEvent, LaneEvent } from "../../src/kernel/lane.ts";
import { ProjectState, WorkState } from "../../src/kernel/records.ts";
import { stateDoc } from "../../src/kernel/state.ts";
import type { EffectRunner } from "../../src/kernel/tasks.ts";
import { options } from "../../src/roles/index.ts";
import { createWorkflow } from "../../src/workflow.ts";

/** The production entry and coding tools, with scripted models and a real cwd. */
export async function openScriptedWorkflow(
	cwd: string,
	storage: Storage,
	first: boolean,
	runner?: EffectRunner,
	now?: () => number,
) {
	const k = createWorkflow(runner);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(Codemode);
	registry.install(k.extension);
	const roles = ["designer", "coordinator", "worker", "verifier"];
	const provider = fauxProvider({ models: roles.map((id) => ({ id })) });
	const queueProvider = fauxProvider({
		provider: "queue-fixture",
		models: [{ id: "investigator" }],
	});
	const sweeper = fauxProvider({
		provider: "sweep-fixture",
		models: [{ id: "sweeper" }],
	});
	const secondCandidate = fauxProvider({ provider: "candidate-fixture" });
	const judge = fauxProvider({ provider: "judge-fixture" });
	const challenger = fauxProvider({ provider: "challenger-fixture" });
	const explorer = fauxProvider({ provider: "explorer-fixture" });
	const models = createModels();
	for (const p of [
		provider,
		queueProvider,
		sweeper,
		secondCandidate,
		judge,
		challenger,
		explorer,
	])
		models.setProvider(p.provider);
	const store = await openStore(
		storage,
		{
			registry,
			models,
			...(now && { now }),
			env: (target) =>
				new NodeExecutionEnv({
					cwd: target.cwd ?? cwd,
					shellEnv: {
						...process.env,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
					},
				}),
		},
		ctx,
	);
	const { harness } = store;
	if (first)
		await harness.commit(
			(tx) =>
				options.set(tx, {
					design: "faux/designer",
					build: "faux/coordinator",
					worker: "faux/worker",
					verify: "faux/verifier",
					queue: "queue-fixture/investigator",
					arena_seat_1: "faux/designer",
					arena_seat_2: `candidate-fixture/${secondCandidate.getModel().id}`,
					arena_judge: `judge-fixture/${judge.getModel().id}`,
					arena_challenger: `challenger-fixture/${challenger.getModel().id}`,
					design_explorer: `explorer-fixture/${explorer.getModel().id}`,
				}),
			ctx,
		);
	const root = first
		? await harness.root(ctx, {
				agent: { ...(await harness.commit(k.entry, ctx)), cwd },
			})
		: await harness.root(ctx);
	const errors: string[] = [];
	function turn(
		role: string,
		name: string,
		args: JsonObject,
		...expectedInput: (string | { tool: string; text: string })[]
	): Extract<FauxResponseStep, (...args: never[]) => unknown> {
		return (context, _, __, model) => {
			if (model.id !== role)
				errors.push(`${name}: expected ${role}, got ${model.id}`);
			const latest = JSON.stringify(
				context.messages.filter((m) => m.role === "user").at(-1),
			);
			const last = context.messages.at(-1);
			for (const part of expectedInput) {
				if (typeof part === "string") {
					if (!latest?.includes(part))
						errors.push(
							`${role}.${name}: latest input did not include ${part}`,
						);
				} else if (
					last?.role !== "toolResult" ||
					last.toolName !== part.tool ||
					!JSON.stringify(last.content).includes(part.text)
				) {
					errors.push(
						`${name}: expected ${part.tool} to return ${part.text}; got ${JSON.stringify(last)?.slice(0, 300)}`,
					);
				}
			}
			if (last?.role === "toolResult" && last.isError)
				errors.push(`${last.toolName}: ${JSON.stringify(last.content)}`);
			return fauxAssistantMessage([fauxToolCall(name, args)], {
				stopReason: "toolUse",
			});
		};
	}
	async function settle(
		ignore: (kind: string, input: unknown) => boolean = () => false,
	) {
		harness.resume();
		for (;;) {
			const tasks = (await harness.inspect(ctx)).tasks.filter(
				({ record }) => !ignore(record.kind, record.input),
			);
			if (!tasks.length) break;
			await Promise.all(
				tasks.map(async ({ record, state }) => {
					assert.notEqual(state.kind, "blocked", record.kind);
					const {
						state: { outcome },
					} = await harness.waitForTask(record.id, ctx);
					assert.notEqual(
						outcome.status,
						"faulted",
						JSON.stringify({ kind: record.kind, outcome }),
					);
				}),
			);
		}
		assert.deepEqual(errors, []);
	}
	const work = workId(root.id);
	const commit = <T>(fn: (tx: Tx) => T | Promise<T>) => harness.commit(fn, ctx);
	const asks = async () =>
		Object.values(
			(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
		);
	async function readAsk(slot: ProjectState["asks"][string]) {
		return commit(async (tx) => {
			const d = await decision(tx, slot.decision);
			assert.ok(d?.status === "open", `no open decision for ${slot.local}`);
			const basis = await tx.entry(d.basis);
			return { slot, d, text: (basis?.data as { text: string }).text };
		});
	}
	async function openAsk(
		matches: (slot: ProjectState["asks"][string]) => boolean,
	) {
		const open = await asks();
		const matching = open.filter(matches);
		assert.equal(
			matching.length,
			1,
			`open decisions: ${open.map((a) => a.local)}`,
		);
		return readAsk(matching[0]!);
	}
	const answer = async (
		d: { id: DecisionId; basis: Parameters<typeof fauxAnswer>[2]["basis"] },
		choice: string,
		annotations: Annotation[] = [],
	) => {
		const result = await fauxAnswer(store, d.id, {
			basis: d.basis,
			choice,
			annotations,
		});
		assert.equal(result.kind, "answered");
		return result;
	};
	const scope = (lane: string) =>
		lane === "queue" || lane === "trunk" ? null : work;
	const send = (lane: string, event: LaneEvent) =>
		commit((tx) => k.transact(tx, { lane, work: scope(lane), event }, 1));
	const fact = (lane: string, fact: KernelEvent) =>
		commit((tx) => k.transact(tx, { lane, work: scope(lane), fact }, 1));
	async function done(lane: string, prefix: string, result: JsonObject) {
		const effects =
			(await harness.snapshot(stateDoc(WorkState), work, ctx))?.effects ?? {};
		const key = Object.keys(effects).findLast((k) =>
			k.startsWith(`${lane}:${prefix}`),
		);
		assert.ok(key, `no ${lane} effect starting with ${prefix}`);
		return fact(lane, {
			kind: "effect_done",
			key: effectKey(key.slice(lane.length + 1)),
			result,
		});
	}
	return {
		store,
		work,
		commit,
		asks,
		readAsk,
		openAsk,
		answer,
		send,
		fact,
		done,
		submit: (text: string) =>
			root.submit({ type: "input", content: text }, ctx),
		close: () => harness.close(ctx),
		root,
		transact: k.transact,
		options: k.options,
		provider,
		queueProvider,
		sweeper,
		secondCandidate,
		judge,
		challenger,
		explorer,
		turn,
		settle,
		newDesigner: async () =>
			harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { ...(await harness.commit(k.entry, ctx)), cwd },
				},
				ctx,
			),
	};
}
