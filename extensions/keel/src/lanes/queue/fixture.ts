import type { WorkId } from "../../kernel/ids.ts";
import type { Sha } from "../../repo/index.ts";

// Version-one storage contract, independent of the reducer's types.
type QueueV1 = {
	findings: {
		work: WorkId;
		lane: "design" | "build" | "verify";
		item: string | null;
		cause: string;
		evidence: string;
		goal: string;
		resume: string;
		status: "open" | "resumed" | "resolved" | "cancelled";
	}[];
	triage: {
		entries: {
			id: number;
			intake: {
				work: WorkId | null;
				source:
					| "owner"
					| "designer"
					| "coordinator"
					| "worker"
					| "verifier"
					| "diagnoser"
					| "investigator";
				item: string | null;
				sha: Sha | null;
				text: string;
				report: string | null;
				nodes: string[];
				edgeCase: { failure: string; likelihood: string; cost: string } | null;
				pattern: string | null;
				blocking: boolean;
			};
			basis: string | null;
			status:
				| "filed"
				| "triage"
				| "routed"
				| "dropped"
				| "deferred"
				| "duplicate"
				| "blessed"
				| "cancelled"
				| "revision_pending"
				| "no_action"
				| "revision_declined"
				| "settled";
			investigation: {
				classification:
					| "defect_in_scope"
					| "determined"
					| "sets_precedent"
					| "mandate_wrong"
					| "unapproved_pattern"
					| "duplicate"
					| "no_action";
				nodes: string[];
				evidence: string;
				size: string;
				cause: string;
				recommendation: string;
				reference: string | null;
				duplicateOf: number | null;
			} | null;
			batch: number | null;
			disposition: string | null;
		}[];
		patterns: {
			name: string;
			finding: number;
			evidence: string;
			status: "blessed" | "revoked";
		}[];
		context: string;
		attempt: number;
		direction: string;
		stall: { cause: string; lastWords: string } | null;
	};
};
export const queueFixture = {
	version: 1,
	sample: (): QueueV1 => ({
		findings: [
			{
				work: 1 as WorkId,
				lane: "verify",
				item: "i1",
				cause: "thread/1",
				evidence: "The predicate still fails after two fixes.",
				status: "open",
				goal: "Check the predicate.",
				resume: "Send the evidence to the worker for rework.",
			},
		],
		triage: {
			entries: [
				{
					id: 1,
					intake: {
						work: 1 as WorkId,
						source: "worker",
						item: "i1",
						sha: null,
						text: "Which ledger owns rounding?",
						report: "The balances differ by a cent.",
						nodes: ["S1"],
						edgeCase: null,
						pattern: null,
						blocking: true,
					},
					basis: "Decide what to do about rounding.",
					status: "triage",
					investigation: {
						classification: "mandate_wrong",
						nodes: ["S1"],
						evidence: "Rounding twice causes the discrepancy.",
						size: "small",
						cause: "the boundary",
						recommendation: "build",
						reference: null,
						duplicateOf: null,
					},
					batch: 1,
					disposition: null,
				},
			],
			patterns: [],
			context: "",
			attempt: 0,
			direction: "",
			stall: null,
		},
	}),
};
