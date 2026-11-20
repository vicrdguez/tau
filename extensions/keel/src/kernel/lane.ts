import type { Annotation, DecisionId } from "tau";
import type { JsonObject } from "tau/durable";
import type { KeelOptions, RoleName } from "../roles/index.ts";
import type {
	AgentKey,
	EffectKey,
	SubjectLocal,
	Token,
	WorkId,
} from "./ids.ts";
import type { StateDef } from "./state.ts";

export { prose } from "tau";
export { defineLaneTool } from "./tool.ts";

/** Tools and messages use lane-defined kinds. These four facts come from the kernel. */
export type KernelEvent =
	| {
			kind: "answered";
			subject: SubjectLocal;
			decision: DecisionId;
			choice: string;
			annotations: (Annotation & { n: number })[];
	  }
	| { kind: "effect_done"; key: EffectKey; result: JsonObject }
	| { kind: "effect_failed"; key: EffectKey; error: string }
	| {
			kind: "agent_stalled";
			agent: AgentKey;
			tokens: Token[];
			cause: "failed" | "stopped" | "unfulfilled";
			lastWords: string;
	  };
export type LaneEvent = JsonObject & { kind: string };
export type Delivery = { lane: string; work: WorkId | null; event: LaneEvent };
/** Kept distinct from lane-authored events even when their kind strings coincide. */
export type FactDelivery = Omit<Delivery, "event"> & { fact: KernelEvent };
export type Message = Omit<Delivery, "work"> & { work: WorkId | null | "new" };
export type Result = { reject: string } | { reply: string | null };
export type Ask = {
	subject: SubjectLocal;
	title: string;
	basis: string;
	choices: readonly [string, ...string[]];
};
/** A token identifies one situation in this conversation. Use a new sequence on re-entry. */
export type Expectation = {
	token: Token;
	tools: readonly string[];
	/** Null: no delivery. Only the anchor designer may answer without preceding tagged input. */
	input: (() => string) | null;
};
export type AgentDecl = {
	key: AgentKey;
	role: RoleName;
	cwd: string | null;
	paused: boolean;
	expects: readonly Expectation[];
};
/** A key names one immutable plan, including across retries. A new plan needs a new key. */
export type EffectDecl = { key: EffectKey; spec: JsonObject };
export type Note = { text: string; agent: AgentKey | null };
export type Accepted<S> = {
	state: S;
	send?: readonly Message[];
	notes?: readonly Note[];
	reply?: string;
};
export type Reduction<S> = { reject: string } | Accepted<S>;

export interface StaticFacts {
	readonly work: WorkId | null;
	readonly root: string;
	readonly options: Readonly<KeelOptions>;
}
export interface World extends StaticFacts {
	readonly now: number;
	/** A claimed operation can still report a result after cancellation. Scoped to this work and lane. */
	runningEffect?(key: EffectKey): boolean;
	/** Detached view; null for a work not in hand. Project lanes use null. */
	view(lane: string, work?: WorkId | null): unknown;
}

/** The document scope selects the address: conversation = one work, session = project. */
export interface Lane<S extends JsonObject> {
	name: string;
	state: Exclude<StateDef<S>, { scope: "task" }>;
	reduce(state: S, event: LaneEvent, world: World): Reduction<S>;
	onFact(state: S, fact: KernelEvent, world: World): Accepted<S>;
	view(state: S): unknown;
	asks: (state: S, facts: StaticFacts) => readonly Ask[];
	agents: (state: S, facts: StaticFacts) => readonly AgentDecl[];
	effects: (state: S, facts: StaticFacts) => readonly EffectDecl[];
}

/** Keep each reducer paired with its own document type in a heterogeneous registry. */
export function defineLane<S extends JsonObject, F extends JsonObject>(
	lane: Lane<S>,
	fixture: { version: number; sample: () => F } & ([S, F] extends [F, S]
		? unknown
		: never),
) {
	if (
		fixture?.version !== lane.state.version ||
		typeof fixture.sample !== "function"
	)
		throw new Error(
			`Missing or outdated state fixture for ${lane.name} v${lane.state.version}`,
		);
	return {
		name: lane.name,
		scope: lane.state.scope,
		use: <T>(visit: <State extends JsonObject>(lane: Lane<State>) => T) =>
			visit(lane),
	};
}
export type RegisteredLane = ReturnType<typeof defineLane>;
