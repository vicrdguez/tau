import type { WorkId } from "../../kernel/ids.ts";
import { type Message, prose } from "../../kernel/lane.ts";
import type { Sha } from "../../repo/index.ts";

const dir = `${import.meta.dirname}/../../prose/documents/resume`;
const action = (name: string) => prose(dir, `${name}.md`, [])({}).trim();
/** Render the action at filing time so a durable finding describes its particular hold. */
export const resumption = {
	discovery: action("discovery"),
	moved: action("moved"),
	occupied: action("occupied"),
	worker: action("worker"),
	coordinator: action("coordinator"),
	trunk: action("trunk"),
	diagnosis: action("diagnosis"),
	pinned: prose(dir, "pinned.md", ["operation"]),
	stalled: prose(dir, "stalled.md", ["agent"]),
};

export type Holding = {
	goal: string;
	resume: string;
	work: WorkId;
	lane: "design" | "build" | "verify";
	item: string | null;
	cause: string;
	evidence: string;
};
export type Resume = {
	kind: "resume";
	item: string | null;
	cause: string;
	evidence: string;
	direction: string;
};
// Session address on the envelope, affected work in the finding.
export function fileHolding(finding: Holding): Message {
	return { lane: "queue", work: null, event: { kind: "file", ...finding } };
}

export type HoldingAddress = Pick<Holding, "work" | "lane" | "cause">;
export function resolveHolding(finding: HoldingAddress): Message {
	return {
		lane: "queue",
		work: null,
		event: { kind: "resolve_holding", ...finding },
	};
}

export type Intake = {
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

export function fileIntake(finding: Intake): Message {
	return { lane: "queue", work: null, event: { kind: "intake", ...finding } };
}
