import { agentKey, token } from "../../kernel/ids.ts";
import { type AgentDecl, prose } from "../../kernel/lane.ts";
import { type Build, held, type Item, workerKey } from "./state.ts";

const dir = import.meta.dirname;
function authority(s: Build, labels?: string[]) {
	const m = s.mandate!;
	const rows: [string, string][] = [
		["intent", m.intent],
		...m.nodes.map(({ label, rule, probe }): [string, string] => [
			label,
			[rule, probe].filter(Boolean).join("\n\n"),
		]),
		...m.checks.map(({ id, argv, timeoutMs }): [string, string] => [
			id,
			`${JSON.stringify(argv)} (${timeoutMs} ms)`,
		]),
		["protectedPaths", m.protectedPaths.join("\n")],
	];
	const nodes = rows
		.filter(([label]) => !labels || labels.includes(label))
		.map(([label, content]) => `### ${label}\n\n${content}`)
		.join("\n\n");
	return labels ? nodes : `Owner-reviewed: ${m.reviewed}\n\n${nodes}`;
}
const plan = prose(dir, "../../prose/inputs/build/plan.md", [
	"mandate",
	"direction",
	"encode",
	"annotations",
]);
const encode = prose(dir, "../../prose/documents/build-encode.md", []);
const annotations = prose(dir, "../../prose/documents/build-annotations.md", [
	"notes",
]);
const correction = prose(dir, "../../prose/inputs/build/correction.md", [
	"mandate",
	"direction",
	"reason",
	"plan",
]);
const askBrief = prose(dir, "../../prose/inputs/build/brief-request.md", [
	"id",
	"kind",
	"goal",
	"head",
	"deps",
	"reason",
	"mandate",
	"direction",
]);
const handoff = prose(dir, "../../prose/inputs/build/handoff.md", [
	"mandate",
	"direction",
	"head",
	"plan",
]);
const brief = prose(dir, "../../prose/documents/build-brief.md", [
	"id",
	"goal",
	"evidence",
	"fences",
	"reason",
	"nodes",
]);
const initial = prose(dir, "../../prose/inputs/build/brief.md", [
	"path",
	"branch",
	"brief",
	"mandate",
	"direction",
]);
const resumed = prose(dir, "../../prose/inputs/build/resume.md", [
	"brief",
	"direction",
	"evidence",
	"threads",
	"path",
	"branch",
	"mandate",
]);
const rework = prose(dir, "../../prose/inputs/build/rework.md", [
	"evidence",
	"threads",
	"brief",
	"direction",
]);
const integrate = prose(dir, "../../prose/inputs/build/integration.md", [
	"evidence",
	"threads",
	"brief",
	"direction",
	"branch",
]);
export const ownerDirection = prose(
	dir,
	"../../prose/documents/build-direction.md",
	["evidence", "direction"],
);

const fullReview = prose(dir, "../../prose/documents/build-full-review.md", [
	"evidence",
	"threads",
]);
const trunkFailure = prose(
	dir,
	"../../prose/documents/build-trunk-failure.md",
	["evidence", "threads", "trunk"],
);
const report = prose(dir, "../../prose/documents/build-report.md", [
	"brief",
	"summary",
]);
function fullContext(s: Build) {
	const reason = s.coordinator.reason;
	if (!reason) return "";
	const facts = {
		evidence: reason.evidence,
		threads: reason.threads.join(", ") || "None.",
	};
	return reason.kind === "rework"
		? fullReview(facts)
		: trunkFailure({
				...facts,
				trunk: reason.inheritedTrunk ?? "the trunk commit named in the failure",
			});
}
function renderBrief(s: Build, i: Item) {
	if (!i.brief) throw Error("Missing worker brief");
	return brief({
		id: i.id,
		...i.brief,
		nodes: authority(s, i.brief.nodes),
		reason: fullContext(s),
	});
}
export const renderReport = (s: Build, i: Item, summary: string) =>
	report({ brief: renderBrief(s, i), summary });
function coordInput(s: Build) {
	const c = s.coordinator;
	const facts = {
		direction: c.direction,
		mandate: authority(s),
	};
	const planRecord = () =>
		JSON.stringify(
			s.items.map(({ id, kind, goal, deps, publication, rulings }) => ({
				id,
				kind,
				goal,
				deps,
				publication,
				rulings,
			})),
			null,
			2,
		);
	switch (c.tool) {
		case "publish_plan":
			return c.reason
				? correction({ ...facts, plan: planRecord(), reason: fullContext(s) })
				: plan({
						...facts,
						encode: s.mandate!.encodeRequired ? encode({}) : "",
						annotations: s.mandate!.approvalNotes.length
							? annotations({
									notes: s
										.mandate!.approvalNotes.map(
											(note, n) => `${n + 1}. ${note}`,
										)
										.join("\n"),
								})
							: "",
					});
		case "brief_item": {
			const i = s.items.find((i) => i.id === c.item)!;
			return askBrief({
				...facts,
				id: i.id,
				goal: i.goal,
				deps: i.deps.join(", "),
				kind: i.kind,
				reason: fullContext(s),
				head: s.head!,
			});
		}
		case "handoff_build":
			return handoff({ ...facts, head: s.head!, plan: planRecord() });
		default:
			throw Error("No coordinator turn");
	}
}
function workerInput(s: Build, i: Item) {
	const w = i.worker!;
	const common = {
		brief: renderBrief(s, i),
		direction: i.direction,
		threads: i.threads.join(", ") || "None.",
		evidence: i.evidence,
	};
	switch (i.input) {
		case "resume":
		case "brief":
			return (i.input === "resume" ? resumed : initial)({
				...common,
				path: w.path,
				branch: w.branch,
				mandate: authority(s),
			});
		case "rework":
			return rework(common);
		case "integration":
			return integrate({ ...common, branch: w.from });
	}
}
export function agents(s: Build): AgentDecl[] {
	if (s.phase !== "active" && s.phase !== "handed_off") return [];
	const c = s.coordinator;
	const out: AgentDecl[] = [
		{
			key: agentKey("coordinator"),
			role: "coordinator",
			cwd: null,
			paused: held(s, null),
			expects:
				c.tool && !held(s, null)
					? [
							{
								token: token(c.tool, c.seq),
								tools: [c.tool],
								input: () => coordInput(s),
							},
						]
					: [],
		},
	];
	for (const i of s.items) {
		if (i.stage !== "building" && i.stage !== "published") continue;
		out.push({
			key: agentKey(workerKey(i)),
			role: "worker",
			cwd: i.worker!.path,
			paused: held(s, i.id),
			expects:
				i.stage === "building" && !held(s, i.id)
					? [
							{
								token: token("publish", i.seq),
								tools: ["publish_build"],
								input: () => workerInput(s, i),
							},
						]
					: [],
		});
	}
	return out;
}
