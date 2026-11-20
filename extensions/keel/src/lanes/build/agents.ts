import { agentKey, token } from "../../kernel/ids.ts";
import { type AgentDecl, prose } from "../../kernel/lane.ts";
import { type Build, held, type Item, workerKey } from "./state.ts";

const dir = import.meta.dirname;
const plan = prose(dir, "../../prose/inputs/build/plan.md", [
	"mandate",
	"direction",
]);
const correction = prose(dir, "../../prose/inputs/build/correction.md", [
	"mandate",
	"direction",
	"reason",
	"plan",
]);
const askBrief = prose(dir, "../../prose/inputs/build/brief-request.md", [
	"id",
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
	["evidence", "threads"],
);
const report = prose(dir, "../../prose/documents/build-report.md", [
	"brief",
	"summary",
]);
function fullContext(s: Build) {
	const reason = s.coordinator.reason;
	if (!reason) return "";
	const render = reason.kind === "rework" ? fullReview : trunkFailure;
	return render({
		evidence: reason.evidence,
		threads: reason.threads.join(", "),
	});
}
function renderBrief(s: Build, i: Item) {
	if (!i.brief) throw Error("Missing worker brief");
	return brief({
		id: i.id,
		...i.brief,
		nodes: i.brief.nodes.join(", "),
		reason: fullContext(s),
	});
}
export const renderReport = (s: Build, i: Item, summary: string) =>
	report({ brief: renderBrief(s, i), summary });
function coordInput(s: Build) {
	const c = s.coordinator;
	const facts = {
		direction: c.direction,
		mandate: JSON.stringify(s.mandate, null, 2),
	};
	const planRecord = () =>
		JSON.stringify(
			s.items.map(({ id, goal, publication, rulings }) => ({
				id,
				goal,
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
				: plan(facts);
		case "brief_item": {
			const i = s.items.find((i) => i.id === c.item)!;
			return askBrief({
				...facts,
				id: i.id,
				goal: i.goal,
				deps: i.deps.join(", "),
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
		threads: i.threads.join(", "),
		evidence: i.evidence,
	};
	switch (i.input) {
		case "brief":
			return initial({
				...common,
				path: w.path,
				branch: w.branch,
				mandate: JSON.stringify(s.mandate, null, 2),
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
