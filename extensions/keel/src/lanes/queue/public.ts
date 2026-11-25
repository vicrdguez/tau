import type { WorkId } from "../../kernel/ids.ts";
import type { Message } from "../../kernel/lane.ts";
import type { Sha } from "../../repo/index.ts";
import type { PrincipleSample } from "../build/public.ts";
import type { AuthorityIndex } from "../design/public.ts";

export const cancelWork = (work: WorkId): Message => ({
	lane: "queue",
	work: null,
	event: { kind: "cancel_work", work },
});

export type Intake = {
	work: WorkId | null;
	source:
		| "owner"
		| "designer"
		| "coordinator"
		| "worker"
		| "verifier"
		| "diagnoser"
		| "investigator"
		| "sweeper";
	item: string | null;
	sha: Sha | null;
	text: string;
	report: string | null;
	nodes: string[];
	edgeCase: { failure: string; likelihood: string; cost: string } | null;
	pattern: string | null;
	blocking: boolean;
	principle?: true;
};

export function fileIntake(finding: Intake): Message {
	return { lane: "queue", work: null, event: { kind: "intake", ...finding } };
}

export const sweepConfigured = {
	lane: "queue",
	work: null,
	event: { kind: "sweep_configured" },
} as const;
export type SweepFinding = {
	text: string;
	report: string;
	pattern?: string | null;
	principle?: boolean;
};

export type LandingSample = PrincipleSample & { work: WorkId };
export type SweepHistory = {
	authority: AuthorityIndex[];
	samples: LandingSample[];
	patternRulings: unknown;
	priorFindings: {
		id: number;
		text: string;
		report: string | null;
		disposition: string;
	}[];
};

export type FindingDisposition = {
	kind: "revision_disposition";
	work: WorkId;
	causes: string[];
	disposition: string;
};
export function closeFindings(
	work: WorkId,
	causes: string[],
	disposition: string,
): Message {
	const event: FindingDisposition = {
		kind: "revision_disposition",
		work,
		causes,
		disposition,
	};
	return { lane: "queue", work: null, event };
}
