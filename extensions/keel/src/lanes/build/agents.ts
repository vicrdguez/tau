import { agentKey, token } from "../../kernel/ids.ts";
import { type AgentDecl, prose } from "../../kernel/lane.ts";
import { renderMandate } from "../design/public.ts";
import {
	affects,
	type Build,
	held,
	type Item,
	parked,
	workerKey,
} from "./state.ts";

const dir = import.meta.dirname;
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
const discover = prose(dir, "../../prose/inputs/build/discovered.md", [
	"mandate",
	"findings",
	"plan",
	"direction",
]);
const revise = prose(dir, "../../prose/inputs/build/revision-plan.md", [
	"before",
	"mandate",
	"findings",
	"held",
	"affected",
	"recorded",
	"plan",
	"annotations",
	"direction",
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
	"kind",
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
const superseded = prose(dir, "../../prose/inputs/build/superseded.md", [
	"evidence",
	"threads",
	"brief",
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
		kind: i.kind,
		...i.brief,
		fences: i.brief.fences.join("\n"),
		nodes: renderMandate(s.mandate!, i.brief.nodes),
		reason: fullContext(s),
	});
}
export const renderReport = (s: Build, i: Item, summary: string) =>
	report({ brief: renderBrief(s, i), summary });
function coordInput(s: Build) {
	const c = s.coordinator;
	const facts = {
		direction: c.direction,
		mandate: renderMandate(s.mandate!),
	};
	const planRecord = () =>
		JSON.stringify(
			s.items.map(
				({
					id,
					kind,
					goal,
					deps,
					stage,
					verified,
					brief,
					publication,
					rulings,
				}) => ({
					id,
					kind,
					goal,
					deps,
					stage,
					verified: verified || stage === "merged" || stage === "cleaning",
					briefNodes: brief?.nodes ?? [],
					publication,
					rulings,
				}),
			),
			null,
			2,
		);
	const approval = (notes: string[]) =>
		notes.length
			? annotations({
					notes: notes.map((note, n) => `${n + 1}. ${note}`).join("\n"),
				})
			: "";
	switch (c.tool) {
		case "publish_plan": {
			if (c.revising) {
				const p = s.revision!;
				const list = (includes: (item: Item) => boolean) =>
					s.items
						.filter(includes)
						.map((item) => `- ${item.id}: ${item.goal}`)
						.join("\n") || "None.";
				return revise({
					...facts,
					before: renderMandate(s.mandate!, p.nodes),
					mandate: renderMandate(p.mandate),
					findings: p.text || p.nodes.join(", "),
					held: list((i) => held(s, i.id)),
					affected: list((i) => affects(i, p.nodes)),
					recorded: list(
						(i) => i.verified || i.stage === "merged" || i.stage === "cleaning",
					),
					plan: planRecord(),
					annotations: approval(p.mandate.approvalNotes),
				});
			}
			if (c.findings)
				return discover({
					...facts,
					plan: planRecord(),
					findings: JSON.stringify(s.findings.slice(0, c.findings), null, 2),
				});
			return c.reason
				? correction({ ...facts, plan: planRecord(), reason: fullContext(s) })
				: plan({
						...facts,
						encode: s.mandate!.encodeRequired ? encode({}) : "",
						annotations: approval(s.mandate!.approvalNotes),
					});
		}
		case "brief_item": {
			const i = s.items.find((i) => i.id === c.item)!;
			return askBrief({
				...facts,
				direction: [facts.direction, i.direction].filter(Boolean).join("\n"),
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
				mandate: renderMandate(s.mandate!),
			});
		case "rework":
			return rework(common);
		case "superseded":
			return superseded(common);
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
			projectPrinciples: i.projectPrinciples,
			paused: parked(s, i),
			expects:
				i.stage === "building" && !parked(s, i)
					? [
							{
								token: token("publish", i.seq),
								tools: ["publish_build"],
								paths: i.brief!.fences,
								situation:
									i.input === "rework" &&
									i.threads.some((id) => i.publication?.addresses.includes(id))
										? "survived_fix"
										: i.input,
								input: () => workerInput(s, i),
							},
						]
					: [],
		});
	}
	return out;
}
