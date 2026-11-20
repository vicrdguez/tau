import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	CodingTools,
	type ConversationId,
	createRegistry,
	type JsonObject,
	MemoryStorage,
	type Storage,
} from "tau/durable";
import { obj } from "tau/schema";
import { createModels, fauxProvider, openStore } from "tau/testing";
import {
	agentKey,
	effectKey,
	subject,
	token,
	workId,
} from "../src/kernel/ids.ts";
import { createKernel } from "../src/kernel/kernel.ts";
import {
	defineLane,
	defineLaneTool,
	type LaneEvent,
} from "../src/kernel/lane.ts";
import { WorkState } from "../src/kernel/records.ts";
import { defineState, stateDoc } from "../src/kernel/state.ts";
import { options } from "../src/roles/index.ts";
import { sharedFixture, toyFixture } from "./state/toy.ts";

export type ToyState = {
	ask: string | null;
	turn: number;
	agents: number;
	paused: boolean;
	effect: boolean;
	answers: number;
	publications: number;
	stalls: number;
	facts: string[];
	notes: string[];
};
const initial = (): ToyState => ({
	ask: null,
	turn: 0,
	agents: 0,
	paused: false,
	effect: false,
	answers: 0,
	publications: 0,
	stalls: 0,
	facts: [],
	notes: [],
});
export const Toy = defineState({
	kind: "keel.toy",
	scope: "conversation",
	version: 1,
	initial,
});
export const Shared = defineState({
	kind: "keel.shared",
	scope: "session",
	version: 1,
	initial: () => ({ seen: [] as string[] }),
});
const shared = defineLane(
	{
		name: "shared",
		state: Shared,
		view: (s) => s,
		asks: () => [],
		agents: () => [],
		effects: () => [],
		onFact: (state) => ({ state }),
		reduce(s, e) {
			if (e.kind === "forbidden") return { reject: "not allowed" };
			if (e.kind === "changed") return { state: { seen: [] } };
			return { state: { seen: [...s.seen, String(e.kind)] } };
		},
	},
	sharedFixture,
);
export function latch<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { resolve, promise };
}
const toyLane = defineLane(
	{
		name: "toy",
		state: Toy,
		view: (s) => s,
		onFact(s, e) {
			switch (e.kind) {
				case "answered":
					return {
						state: {
							...s,
							answers: s.answers + 1,
							ask: null,
							notes: [JSON.stringify(e.annotations)],
						},
					};
				case "effect_done":
					return {
						state: { ...s, facts: [...s.facts, String(e.result.value)] },
						send: s.ask === "bad follow-up" ? [{ lane: "shared", work: null, event: { kind: "forbidden" } }] : [],
					};
				case "effect_failed":
					return { state: { ...s, facts: [...s.facts, e.error] } };
				case "agent_stalled":
					return { state: { ...s, stalls: s.stalls + 1, notes: [e.cause], turn: 0 } };
			}
		},
		reduce(s, e, world) {
			switch (e.kind) {
				case "ask":
					return { state: { ...s, ask: String(e.basis) } };
				case "all":
					return {
						state: { ...s, ask: "A", agents: 1, turn: 1, effect: true },
						notes: [{ text: "worker ready", agent: agentKey("worker/0") }],
					};
				case "agent":
					return {
						state: {
							...s,
							agents: Number(e.count ?? 1),
							turn: s.turn + 1,
							paused: false,
						},
						notes: [{ text: "worker ready", agent: agentKey("worker/0") }],
					};
				case "manual":
					return { state: { ...s, agents: 2, turn: -1 } };
				case "quiet":
					return { state: { ...s, turn: 0 } };
				case "pause":
					return { state: { ...s, paused: true } };
				case "cancel":
					return { state: { ...s, agents: 0, effect: false, ask: null } };
				case "effect":
					return { state: { ...s, effect: true } };
				case "claimed":
					return { state: s, reply: String(world.runningEffect?.(effectKey("once"))) };
				case "publish":
					return {
						state: { ...s, publications: s.publications + 1, turn: 0 },
						reply: "published once",
					};
				case "reject":
					return { reject: "not allowed" };
				case "bounce":
					return {
						state: { ...s, publications: s.publications + 1 },
						send: [
							{ lane: "shared", work: null, event: { kind: "forbidden" } },
						],
					};
				case "forward":
					return {
						state: s,
						send: [{ lane: "shared", work: null, event: { kind: "hello" } }],
					};
				case "tamper": {
					const view = world.view("shared", null) as { seen: string[] };
					view.seen.push("intruder");
					return { state: s };
				}
				case "cycle":
					return {
						state: s,
						send: [
							{
								lane: "toy",
								work: world.work,
								event: { kind: "cycle", n: Number(e.n ?? 0) + 1 },
							},
						],
					};
				default:
					return { state: s };
			}
		},
		asks: (s, facts) =>
			s.ask === null ||
			(s.ask === "dependent" &&
				// @ts-expect-error a declaration cannot depend on another lane
				!(facts.view?.("shared") as { seen: string[] } | undefined)?.seen
					.length)
				? []
				: Array.from({ length: s.ask === "A" ? 2 : 1 }, () => ({
						subject: subject("review"),
						basis: s.ask!,
						title: "Review",
						choices: ["accept"] as const,
					})),
		agents: (s) =>
			Array.from({ length: s.agents }, (_, i) => ({
				key: agentKey(`worker/${i}`),
				role: s.ask === "designers" ? "designer" : "worker",
				cwd: null,
				paused: s.paused,
				expects:
					s.turn === 0
						? []
						: [
								{
									token: token(`worker/${i}`, Math.abs(s.turn)),
									tools: ["publish"],
									input: s.turn < 0 ? null : () => "work",
								},
							],
			})),
		effects: (s) =>
			s.effect ? [{ key: effectKey("once"), spec: { value: "outside" } }] : [],
	},
	toyFixture,
);

export async function toy({
	storage = new MemoryStorage(),
	observe = async () => {},
	runEffect = async () => ({ value: "outside" }),
	...composition
}: Partial<Parameters<typeof createKernel>[0]> & {
	storage?: Storage;
	observe?: () => Promise<void>;
} = {}) {
	const publish = defineLaneTool({
		lane: "toy",
		roles: ["worker"],
		name: "publish",
		description: "Publish",
		parameters: obj({}),
		terminate: true,
		observe,
		event: () => ({ kind: "publish" }),
	});
	const k = createKernel({
		lanes: [toyLane, shared],
		tools: [publish],
		...composition,
		runEffect,
	});
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(k.extension);
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	const store = await openStore(storage, { registry, models }, ctx);
	const { harness } = store;
	await harness.commit(
		(tx) =>
			options.set(tx, {
				design: "faux/faux-1",
				build: "faux/faux-1",
				verify: "faux/faux-1",
				queue: "faux/faux-1",
			}),
		ctx,
	);
	const root = await harness.root(ctx, {
		agent: {
			...(await harness.commit(k.entry, ctx)),
			cwd: "/projects/quant-engine",
		},
	});
	const deliver = (lane: string, id: ConversationId | null, event: LaneEvent) =>
		harness.commit(
			(tx) =>
				k.transact(
					tx,
					{ lane, work: id === null ? null : workId(id), event },
					Date.now(),
				),
			ctx,
		);
	const send = (kind: string, fields: JsonObject = {}) =>
		deliver("toy", root.id, { ...fields, kind });
	const state = async (id = root.id) =>
		(await harness.snapshot(stateDoc(Toy), id, ctx)) ?? initial();
	const agents = async () =>
		Object.values(
			(await harness.snapshot(stateDoc(WorkState), root.id, ctx))?.agents ?? {},
		).map((a) => a.conversation);
	const tasks = async (kind: string) =>
		(await harness.commit((tx) => tx.scanTasks({}, 200), ctx)).items.filter(
			(t) => t.kind === kind,
		);
	const finish = async (kind: string) => {
		for (const t of await tasks(kind)) {
			const done = await harness.waitForTask(t.id, ctx);
			if (done.state.outcome.status !== "completed")
				throw Error(JSON.stringify(done.state.outcome));
		}
	};
	// Preserve the public Store type rather than emitting the internal Harness type.
	return Object.assign(
		{
			k,
			store,
			root,
			provider,
			send,
			deliver,
			state,
			agents,
			tasks,
			finish,
		},
		store,
	);
}
