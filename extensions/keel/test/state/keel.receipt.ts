import type { ReceiptState } from "../../src/kernel/records.ts";
import type { Check, Exact } from "./fixture.ts";

export type V1 = { reply: string | null; terminate: boolean; isError: boolean };
export type CurrentMatchesV1 = Check<
	Exact<V1, ReturnType<typeof ReceiptState.initial>>
>;

export const current = {
	reply: "published",
	terminate: true,
	isError: false,
} satisfies V1;
