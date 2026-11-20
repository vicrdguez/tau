import type { WorkId } from "../../src/kernel/ids.ts";

// Normalize aliases such as Address & { ... } without erasing optional properties,
// literal unions, or branded IDs. This is a compile-time check, not a decoder.
type Shape<T> = T extends string | number | boolean | null
	? T
	: { [K in keyof T]: Shape<T[K]> };
export type Exact<A, B> =
	(<T>() => T extends Shape<A> ? 1 : 2) extends <T>() => T extends Shape<B>
		? 1
		: 2
		? true
		: false;
export type Check<T extends true> = T;

export type AddressV1 = { lane: string; work: WorkId | null };
// Role names occur in persisted slots; a catalog change must not silently retype v1.
export type RoleV1 =
	| "designer"
	| "design_explorer"
	| "design_prototype"
	| "arena_seat_1"
	| "arena_seat_2"
	| "arena_seat_3"
	| "arena_judge"
	| "arena_challenger"
	| "coordinator"
	| "worker"
	| "build_explorer"
	| "verifier"
	| "diagnoser"
	| "investigator"
	| "queue_explorer";
