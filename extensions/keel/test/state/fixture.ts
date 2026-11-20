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
