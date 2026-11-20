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
			lastWords: string;
	  };
export type LaneEvent = JsonObject & { kind: string };
export type Delivery = { lane: string; work: WorkId | null; event: LaneEvent };
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
	/** Null when the input comes from the owner. The expectation is still required. */
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
export type Reduction<S> =
	| { reject: string }
	| {
			state: S;
			send?: readonly Delivery[];
			notes?: readonly Note[];
			reply?: string;
	  };

export interface World {
	readonly work: WorkId | null;
	readonly now: number;
	readonly options: Readonly<KeelOptions>;
	/** Detached view; null for a work not in hand. Project lanes use null. */
	view(lane: string, work?: WorkId | null): unknown;
}

/** The document scope selects the address: conversation = one work, session = project. */
export interface Lane<S extends JsonObject> {
	name: string;
	state: Exclude<StateDef<S>, { scope: "task" }>;
	reduce(state: S, event: LaneEvent, world: World): Reduction<S>;
	view(state: S): unknown;
	asks(state: S, world: World): readonly Ask[];
	agents(state: S, world: World): readonly AgentDecl[];
	effects(state: S, world: World): readonly EffectDecl[];
}

/** Keep each reducer paired with its own document type in a heterogeneous registry. */
export function defineLane<S extends JsonObject>(lane: Lane<S>) {
	return {
		name: lane.name,
		scope: lane.state.scope,
		use: <T>(visit: <State extends JsonObject>(lane: Lane<State>) => T) =>
			visit(lane),
	};
}
export type RegisteredLane = ReturnType<typeof defineLane>;
