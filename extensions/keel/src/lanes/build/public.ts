import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";
import type { Sha } from "../../repo/index.ts";
import type { Mandate } from "../design/public.ts";

export type BuildUpdate =
	| { kind: "bound"; mandate: Mandate }
	| { kind: "merged"; item: string; head: Sha }
	| {
			kind: "integration" | "rework";
			item: string;
			head: Sha;
			threads: string[];
			evidence: string;
	  }
	| { kind: "closed" };
export function toBuild(work: WorkId, event: BuildUpdate): Message {
	return { lane: "build", work, event };
}

/** Cost ranks are ordinal. A larger rank means a higher cost if wrong. */
export type Ruling = {
	what: string;
	why: string;
	cost: string;
	rank: number;
	follows: string;
};
