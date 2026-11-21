import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";
import type { Sha } from "../../repo/index.ts";
import type { Mandate, Reply } from "../design/public.ts";

export type Approval = {
	revision: number | null;
	notes: (Reply & { text: string })[];
};

export type PlanFinding = {
	kind: "plan_finding";
	text: string;
	reference: string;
	nodes: string[];
	cause?: string;
};
export type RevisionProposal = {
	kind: "propose_revision";
	number: number;
	mandate: Mandate;
	causes: string[];
	nodes: string[];
	text?: string;
};
export type SupersedeReason = "mandate_revision" | "defect_fixed";
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
			reason?: SupersedeReason;
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

export function workRulings(view: unknown) {
	return (
		(view as { rulings: (Ruling & { item: string })[] } | null)?.rulings ?? []
	);
}
