import { defineDoc, type JsonObject } from "tau/durable";

type StateScope = "session" | "conversation" | "task";
type Migration<S> = (value: unknown, fromVersion: number) => S;
type Spec<S> = {
	readonly kind: `keel.${string}`;
	readonly scope: StateScope;
	readonly initial: () => S;
} & (
	| { readonly version: 1; readonly migrate?: Migration<S> }
	| { readonly version: number; readonly migrate: Migration<S> }
);

// Make every field required without losing the undefined from an optional
// field's read type. Such a field then fails the durable JSON constraint.
type StoredFields<T> = JsonObject[string] extends T
	? T // Don't expand the platform's recursive JsonValue type.
	: T extends string | number | boolean | null
		? T
		: {
				[K in keyof T]-?: undefined extends T[K]
					? undefined
					: StoredFields<T[K]>;
			};
type CheckedSpec<S> = Spec<S> &
	([StoredFields<S>] extends [JsonObject] ? unknown : never);

// Lanes see the definition, not the durable token. The kernel retrieves the token
// through stateDoc only after narrowing the definition's scope.
const document: unique symbol = Symbol("keel.document");

function scopedState<S extends JsonObject>({
	kind,
	scope,
	version,
	initial,
	migrate,
}: Spec<S>) {
	if (version > 1 && typeof migrate !== "function")
		throw new TypeError(`${kind} version ${version} requires a migration`);

	const state = { kind, version, initial };
	const persisted = {
		...state,
		...(migrate && { migrate }),
		checkpointWhen: (
			_value: Readonly<S>,
			_ops: readonly unknown[],
			info: { deltasSinceBase: number },
		) => info.deltasSinceBase + 1 >= 64,
	};
	switch (scope) {
		case "session":
			return {
				...state,
				scope,
				[document]: defineDoc<S>({ ...persisted, scope }),
			} as const;
		case "conversation":
			return {
				...state,
				scope,
				[document]: defineDoc<S>({
					...persisted,
					scope,
					history: "latest",
					fork: "initial",
				}),
			} as const;
		case "task":
			return {
				...state,
				scope,
				[document]: defineDoc<S>({ ...persisted, scope }),
			} as const;
	}
}

export type StateDef<S extends JsonObject> = ReturnType<typeof scopedState<S>>;

export function defineState<S extends JsonObject>(
	spec: CheckedSpec<S> & { scope: "session" },
): Extract<StateDef<S>, { scope: "session" }>;
export function defineState<S extends JsonObject>(
	spec: CheckedSpec<S> & { scope: "conversation" },
): Extract<StateDef<S>, { scope: "conversation" }>;
export function defineState<S extends JsonObject>(
	spec: CheckedSpec<S> & { scope: "task" },
): Extract<StateDef<S>, { scope: "task" }>;
export function defineState<S extends JsonObject>(spec: Spec<S>): StateDef<S> {
	return scopedState(spec);
}

/** Kernel-only. Preserves the concrete tau document scope and stored value type. */
export function stateDoc<D>(def: { readonly [document]: D }): D {
	return def[document];
}
