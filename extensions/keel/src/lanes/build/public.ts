import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";
import type { Sha } from "../../repo/index.ts";
import type { Mandate } from "../design/public.ts";

export type PlanFinding = {
	kind: "plan_finding";
	text: string;
	reference: string;
	nodes: string[];
	cause?: string;
};
export type RevisionProposal = {
	kind: "propose_revision";
	mandate: Mandate;
	causes: string[];
	nodes: string[];
	text?: string;
};
export type BuildUpdate =
	| { kind: "bound"; mandate: Mandate }
	| { kind: "item_verified"; item: string }
	| { kind: "merged"; item: string; head: Sha }
	| {
			kind: "queue_hold";
			item: string | null;
			nodes: string[];
			cause: string;
			evidence?: string;
	  }
	| { kind: "queue_release"; cause: string; direction?: string }
	| PlanFinding
	| RevisionProposal
	| {
			kind: "integration" | "rework";
			item: string;
			head: Sha;
			inheritedTrunk?: Sha;
			direction?: string;
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
	principles: string[];
};
