import { agentKey, effectKey, subject, token } from "../../kernel/ids.ts";
import {
	type AgentDecl,
	type Ask,
	type EffectDecl,
	prose,
} from "../../kernel/lane.ts";
import type { Ruling } from "../build/public.ts";
import { renderMandate } from "../design/public.ts";
import { cleaning, held, queueHeld, type Review, type State } from "./state.ts";

const dir = `${import.meta.dirname}/../../prose`;
const inputs = {
	item: prose(dir, "inputs/verify/item.md", ["facts"]),
	rework: prose(dir, "inputs/verify/rework.md", ["facts"]),
	integration: prose(dir, "inputs/verify/integration.md", ["facts"]),
	full: prose(dir, "inputs/verify/full.md", ["facts", "owed"]),
	landing: prose(dir, "inputs/verify/landing.md", ["facts", "owed"]),
};
const form = prose(dir, "documents/verify-facts.md", [
	"sha",
	"base",
	"path",
	"brief",
	"mandate",
	"rulings",
	"playbook",
	"history",
	"addresses",
	"changedPolicyFiles",
]);
const diagnose = prose(dir, "inputs/verify/diagnosis.md", ["facts", "threads"]);
const resume = prose(dir, "inputs/verify/resume.md", ["direction", "task"]);
const handoverEvidence = prose(dir, "documents/handover-evidence.md", [
	"sha",
	"result",
	"intent",
	"summary",
	"verdict",
	"rulings",
	"notes",
	"risk",
	"diagnoses",
	"directions",
	"revisions",
	"findings",
	"approvalReplies",
]);
const handover = prose(dir, "documents/handover.md", [
	"trunk",
	"sha",
	"owed",
	"evidence",
	"base",
]);
const title = prose(dir, "documents/handover-title.md", [
	"trunk",
	"sha",
	"goal",
]);
const changed = prose(dir, "documents/landing-changed.md", [])({});
const unchanged = prose(dir, "documents/landing-unchanged.md", [])({});
function rulings(rs: Ruling[]) {
	return (
		rs
			.map(
				(r) =>
					`${r.what}\n  Why: ${r.why}. Cost if wrong: ${r.cost}. Follows: ${r.follows}.${r.principles.length ? ` Principles: ${r.principles.join(", ")}.` : ""}`,
			)
			.join("\n") || "None."
	);
}
export function agentFor(c: Review) {
	return c.phase === "diagnose"
		? agentKey(`diagnose/${c.checkout!.key}`)
		: agentKey(`verify/${c.item}`);
}
function input(s: State, c: Review) {
	const history = s.verdicts.filter((v) => v.item === c.item);
	const changedPolicyFiles =
		c.scope === "item"
			? c.changedPolicyFiles
			: s.checks
					.filter((other) => other.phase === "merged")
					.flatMap((other) => other.changedPolicyFiles);
	const facts = form({
		sha: c.sha,
		base: c.base,
		path: c.checkout!.path,
		brief: c.brief,
		changedPolicyFiles: [...new Set(changedPolicyFiles)].join("\n") || "None.",
		mandate: renderMandate(s.mandate!),
		rulings: rulings(c.rulings),
		playbook: c.playbook ?? "None.",
		history:
			history
				.map(
					(v) =>
						`${v.sha} (${v.outcome}; addressed: ${v.addresses.join(", ")}): ${v.text}\n${v.blocks.map((b) => `${b.thread} (${b.ground}): ${b.evidence}`).join("\n")}`,
				)
				.join("\n") || "None.",
		addresses: c.addresses.join(", ") || "None.",
	});
	const task =
		c.phase === "diagnose"
			? diagnose({ facts, threads: history.at(-1)!.diagnose.join(", ") })
			: c.scope !== "item"
				? inputs[c.scope]({ facts, owed: c.owed?.text || "None." })
				: inputs[
						!history.length
							? "item"
							: history.at(-1)?.outcome === "pass"
								? "integration"
								: "rework"
					]({ facts });
	return c.direction ? resume({ direction: c.direction, task }) : task;
}
export function agents(s: State): AgentDecl[] {
	if (s.cancelled) return [];
	return s.checks
		.filter((c) => c.phase === "verify" || c.phase === "diagnose")
		.map((c) => {
			const paused = held(s, c.item);
			return {
				key: agentFor(c),
				role: c.phase === "diagnose" ? "diagnoser" : "verifier",
				cwd: c.checkout!.path,
				paused,
				expects: paused
					? []
					: [
							{
								token: token(agentFor(c), c.turn),
								tools: [
									c.phase === "diagnose"
										? "publish_diagnosis"
										: "publish_verdict",
								],
								paths: c.paths,
								situation:
									c.phase === "diagnose" ? "diagnosis" : "verification",
								input: () => input(s, c),
							},
						],
			};
		});
}
export function effects(s: State): EffectDecl[] {
	return s.jobs
		.filter(
			(j) =>
				s.cancelled ||
				(!s.holds.some((h) => h.job === j.key) &&
					!(j.op.kind === "checkout" && queueHeld(s, j.item)) &&
					(j.op.kind === "remove" || !cleaning(s, j.item))),
		)
		.map(({ key, op }) => ({
			key: effectKey(key),
			spec:
				op.kind === "read_repo"
					? { kind: op.kind, base: op.base, trunk: op.trunk }
					: { repo: s.repo!, op },
		}));
}
export function rejectedEvidence(s: State): string {
	const h = s.handover!,
		info = s.handoff!;
	return handoverEvidence({
		sha: h.sha,
		result: h.unchanged ? unchanged : changed,
		intent: s.mandate!.intent,
		summary: info.summary,
		verdict: s.verdicts
			.filter((v) => v.scope !== "item" && v.outcome === "pass")
			.map((v) => v.text)
			.join("\n"),
		rulings: rulings([...info.rulings].sort((a, b) => b.rank - a.rank)),
		notes:
			s.verdicts
				.flatMap((v) => v.notes.map((n) => `${v.sha}: ${n}`))
				.join("\n") || "None.",
		risk: info.risk,
		directions: s.directions.join("\n") || "None.",
		approvalReplies:
			info.approvals
				.map(({ revision, notes }) => {
					const label =
						revision === null
							? "Mandate approval"
							: `Revision ${revision} approval`;
					return `#### ${label}\n\n${notes.map((n) => `${n.n}. ${n.text}\n   ${n.status}: ${n.reason}`).join("\n")}`;
				})
				.join("\n\n") || "None.",

		diagnoses: s.diagnoses.join("\n") || "None.",
		revisions: h.revisions || "None.",
		findings: h.findings || "None.",
	});
}
function handoverAsk(s: State): Ask {
	const { sha, owed } = s.handover!;
	const { trunk, base } = s.repo!;
	return {
		subject: subject("handover"),
		title: title({
			trunk,
			sha,
			goal: s.mandate!.intent.trim().split("\n", 1)[0]!,
		}).trim(),
		choices: ["accept", "reject"],
		basis: handover({
			sha,
			trunk,
			base,
			owed: owed || "None.",
			evidence: rejectedEvidence(s),
		}),
	};
}
export function asks(s: State): Ask[] {
	return !s.cancelled && s.handover?.status === "asking"
		? [handoverAsk(s)]
		: [];
}
