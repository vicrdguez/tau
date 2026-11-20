import type { JsonObject, Tx } from "tau/durable";
import type { KeelOptions } from "../roles/index.ts";
import type { WorkId } from "./ids.ts";
import type {
	Delivery,
	Lane,
	LaneEvent,
	Note,
	RegisteredLane,
	World,
} from "./lane.ts";
import { stateDoc } from "./state.ts";

async function load<S extends JsonObject>(tx: Tx, lane: Lane<S>, world: World) {
	const def = lane.state;
	const read = () => {
		if (def.scope === "session") return tx.doc(stateDoc(def));
		if (world.work === null) throw new Error(`Missing work for ${lane.name}`);
		return tx.doc(stateDoc(def), world.work);
	};
	const draft = await read();
	// A tau draft is a transaction-owned proxy. A reducer never gets one, even
	// for its own lane: a later routed rejection must discard the entire chain.
	let state: S = JSON.parse(JSON.stringify(draft));
	const notes: Note[] = [];
	return {
		lane: lane.name,
		work: world.work,
		notes,
		view: () => structuredClone(lane.view(state)),
		reduce(event: LaneEvent) {
			const result = lane.reduce(state, event, world);
			if (!("reject" in result)) {
				state = result.state;
				notes.push(...(result.notes ?? []));
			}
			return result;
		},
		save() {
			for (const key of Object.keys(draft))
				if (!Object.hasOwn(state, key)) Reflect.deleteProperty(draft, key);
			Object.assign(draft, state);
		},
		declarations: () => ({
			asks: lane.asks(state, world),
			agents: lane.agents(state, world),
			effects: lane.effects(state, world),
		}),
	};
}
export type Frame = Awaited<ReturnType<typeof load>>;

/** Read and reduce. Nothing is published until every causal branch accepts. */
export async function route(
	tx: Tx,
	lanes: ReadonlyMap<string, RegisteredLane>,
	first: Delivery,
	now: number,
	options: KeelOptions,
): Promise<{ reject: string } | { frames: Frame[]; reply: string | null }> {
	const scopes = new Map<WorkId | null, Map<string, Frame>>();
	async function loadScope(work: WorkId | null) {
		if (scopes.has(work)) return;
		const frames = new Map<string, Frame>();
		scopes.set(work, frames);
		const world: World = {
			work,
			now,
			options,
			view(name, id = lanes.get(name)?.scope === "session" ? null : work) {
				return scopes.get(id)?.get(name)?.view() ?? null;
			},
		};
		for (const lane of lanes.values()) {
			if ((lane.scope === "session") === (work === null))
				frames.set(lane.name, await lane.use((l) => load(tx, l, world)));
		}
	}
	await loadScope(null);
	// Check causality, not a hop count or a global visited set: independent
	// branches can send the same event, and a request may return a different reply.
	const pending = [{ delivery: first, path: new Set<string>() }];
	const touched = new Set<Frame>();
	let reply: string | null = null;
	for (const { delivery, path } of pending) {
		const { lane, work, event } = delivery;
		await loadScope(work);
		const frame = scopes.get(work)?.get(lane);
		if (!frame)
			throw new Error(
				`Unknown lane or wrong scope: ${lane} (${work ?? "project"})`,
			);
		const step = JSON.stringify([work, lane, event.kind]);
		if (path.has(step))
			throw new Error(`Keel message cycle: ${[...path, step].join(" -> ")}`);
		touched.add(frame);
		const result = frame.reduce(event);
		if ("reject" in result) return { reject: result.reject };
		if (delivery === first) reply = result.reply ?? null;
		if (result.send?.length) {
			const nextPath = new Set(path).add(step);
			for (const message of result.send)
				pending.push({ delivery: message, path: nextPath });
		}
	}
	return {
		reply,
		frames: [...touched],
	};
}
