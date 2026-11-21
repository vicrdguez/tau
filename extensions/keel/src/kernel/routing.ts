import type { JsonObject, Tx } from "tau/durable";
import type { KeelOptions } from "../roles/index.ts";
import { slotKey, type WorkId, workId } from "./ids.ts";
import type {
	Accepted,
	Delivery,
	FactDelivery,
	KernelEvent,
	Lane,
	LaneEvent,
	Message,
	Note,
	RegisteredLane,
	World,
} from "./lane.ts";
import { stateDoc } from "./state.ts";
import { ledger } from "./storage.ts";

async function draftFor<S extends JsonObject>(
	tx: Tx,
	lane: Lane<S>,
	work: WorkId | null,
) {
	const def = lane.state;
	if (def.scope === "session") return tx.doc(stateDoc(def));
	if (work === null) throw new Error(`Missing work for ${lane.name}`);
	return tx.doc(stateDoc(def), work);
}

async function load<S extends JsonObject>(tx: Tx, lane: Lane<S>, world: World) {
	const draft = await draftFor(tx, lane, world.work);
	// A tau draft is a transaction-owned proxy. A reducer never gets one, even
	// for its own lane: a later routed rejection must discard the entire chain.
	let state: S = JSON.parse(JSON.stringify(draft));
	const notes: Note[] = [];
	const facts = Object.freeze({
		work: world.work,
		options: world.options,
		root: world.root,
	});
	function accept(result: Accepted<S>) {
		state = result.state;
		notes.push(...(result.notes ?? []));
	}
	return {
		lane: lane.name,
		work: world.work,
		root: world.root,
		notes,
		// Copy the data, not the projection: a view may expose query methods.
		view: () => lane.view(structuredClone(state)),
		workInHand: (event: LaneEvent | KernelEvent) =>
			lane.workInHand?.(state, event) ?? null,
		reduce(delivery: Message | FactDelivery) {
			const result =
				"fact" in delivery
					? lane.onFact(state, delivery.fact, world)
					: lane.reduce(state, delivery.event, world);
			if (!("reject" in result)) accept(result);
			return result;
		},
		onIdle:
			lane.onIdle &&
			(() => {
				const result = lane.onIdle?.(state, world);
				if (result) accept(result);
				return result;
			}),
		save() {
			for (const key of Object.keys(draft))
				if (!Object.hasOwn(state, key)) Reflect.deleteProperty(draft, key);
			Object.assign(draft, state);
		},
		declarations: () => ({
			asks: lane.asks(state, facts),
			agents: lane.agents(state, facts),
			effects: lane.effects(state, facts),
		}),
	};
}
export type Frame = Awaited<ReturnType<typeof load>>;

export async function readViews(
	tx: Tx,
	lanes: ReadonlyMap<string, RegisteredLane>,
	work: WorkId | null,
) {
	const views = new Map<string, () => unknown>();
	for (const entry of lanes.values()) {
		if (entry.scope === "conversation" && work === null) continue;
		await entry.use(async (lane) => {
			const draft = await draftFor(tx, lane, work);
			const state = JSON.stringify(draft);
			views.set(lane.name, () => lane.view(JSON.parse(state)));
		});
	}
	return (lane: string) => views.get(lane)?.() ?? null;
}

// Allocating an anchor is a table write: a later rejection must roll back the
// transaction rather than commit an empty ownerless conversation.
export class RejectedSeed extends Error {}

export async function route(
	tx: Tx,
	lanes: ReadonlyMap<string, RegisteredLane>,
	first: Delivery | FactDelivery,
	now: number,
	options: KeelOptions,
	root: string,
	caller: WorkId | null,
) {
	const scopes = new Map<WorkId | null, Map<string, Frame>>();
	const effectsByScope = new Map<
		WorkId | null,
		Awaited<ReturnType<typeof ledger>>["effects"]
	>();
	async function loadScope(work: WorkId | null) {
		if (scopes.has(work)) return;
		const frames = new Map<string, Frame>();
		scopes.set(work, frames);
		const world: World = {
			work,
			now,
			options,
			root,
			view(
				name,
				id = lanes.get(name)?.scope === "session" ? null : (work ?? caller),
			) {
				return scopes.get(id)?.get(name)?.view() ?? null;
			},
		};
		const { effects } = await ledger(tx, work);
		effectsByScope.set(work, effects);
		for (const lane of lanes.values()) {
			if ((lane.scope === "session") === (work === null))
				frames.set(
					lane.name,
					await lane.use((l) =>
						load(tx, l, {
							...world,
							runningEffect: (key) =>
								effects[slotKey(lane.name, key)]?.status === "running",
						}),
					),
				);
		}
	}
	await loadScope(null);
	await loadScope(caller);
	let allocated = false;
	// Check causality, not a hop count or a global visited set: independent
	// branches can send the same event, and a request may return a different reply.
	const pending: {
		delivery: Message | FactDelivery;
		path: Set<string>;
	}[] = [{ delivery: first, path: new Set() }];
	const touched = new Set<Frame>();
	let reply: string | null = null;
	let next = 0;
	async function drain() {
		while (next < pending.length) {
			const { delivery, path } = pending[next++]!;
			const { lane } = delivery;
			const event = "fact" in delivery ? delivery.fact : delivery.event;
			const step = JSON.stringify([delivery.work, lane, event.kind]);
			if (path.has(step))
				throw new Error(`Keel message cycle: ${[...path, step].join(" -> ")}`);
			const work =
				delivery.work === "new"
					? workId(
							(
								await tx.createConversation({
									ownership: { kind: "ownerless" },
								})
							).id,
						)
					: delivery.work;
			allocated ||= delivery.work === "new";
			await loadScope(work);
			const frame = scopes.get(work)?.get(lane);
			if (!frame)
				throw new Error(
					`Unknown lane or wrong scope: ${lane} (${work ?? "project"})`,
				);
			const relatedWork = frame.workInHand(event);
			if (relatedWork !== null) await loadScope(relatedWork);
			touched.add(frame);
			const result = frame.reduce(delivery);
			if ("reject" in result) {
				if (allocated) throw new RejectedSeed(result.reject);
				return { reject: result.reject };
			}
			if (delivery === first) reply = result.reply ?? null;
			if (result.send?.length) {
				const nextPath = new Set(path).add(step);
				for (const message of result.send)
					pending.push({ delivery: message, path: nextPath });
			}
		}
	}
	const rejected = await drain();
	if (rejected) return rejected;

	// Only works reached by this transaction can have lost progress. Use the
	// settled declarations, not intermediate states or unrelated project work.
	const projectDecls = [...scopes.get(null)!.values()].map((f) =>
		f.declarations(),
	);
	for (const [work, scope] of scopes) {
		if (work === null) continue;
		const frames = [...scope.values()];
		if (!frames.some((f) => f.onIdle)) continue;
		const owns = (d: { works?: readonly (WorkId | null)[] }) =>
			d.works?.includes(work);
		if (
			projectDecls.some(
				({ asks, agents }) =>
					asks.some(owns) ||
					agents.some((a) => !a.paused && a.expects.some(owns)),
			)
		)
			continue;
		const effects = effectsByScope.get(work)!;
		if (
			Object.values(effects).some(
				(e) => e.status === "running" || e.status === "stopping",
			)
		)
			continue;
		if (
			frames.some((f) => {
				const d = f.declarations();
				return (
					d.asks.length ||
					d.agents.some((a) => !a.paused && a.expects.length) ||
					d.effects.some(
						(e) => effects[slotKey(f.lane, e.key)]?.status !== "done",
					)
				);
			})
		)
			continue;
		for (const f of frames) {
			const idle = f.onIdle?.();
			if (!idle) continue;
			touched.add(f);
			for (const delivery of idle.send ?? [])
				pending.push({ delivery, path: new Set() });
		}
	}
	return (await drain()) ?? { reply, frames: [...touched] };
}
