import { agentKey, effectKey, subject, token } from "../../kernel/ids.ts";
import {
	type AgentDecl,
	type Ask,
	type EffectDecl,
	prose,
} from "../../kernel/lane.ts";
import type { Ruling } from "../build/public.ts";
import type { Review, State } from "./state.ts";

const dir = import.meta.dirname + "/../../prose";
const inputs = Object.fromEntries(
	["item", "rework", "integration", "full", "landing"].map((name) => [
		name,
		prose(dir, `inputs/verify/${name}.md`, ["facts"]),
	]),
);
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
]);
const diagnose = prose(dir, "inputs/verify/diagnosis.md", [
	"facts",
	"principle",
]);
const principle = prose(dir, "principles/attack-the-premise.md", [])({});
const resume = prose(dir, "inputs/verify/resume.md", ["direction", "task"]);
const handover = prose(dir, "documents/handover.md", [
	"trunk",
	"sha",
	"result",
	"intent",
	"summary",
	"verdict",
	"rulings",
	"notes",
	"risk",
	"base",
]);
const title = prose(dir, "documents/handover-title.md", ["trunk", "sha"]);
const changed = prose(dir, "documents/landing-changed.md", [])({});
const unchanged = prose(dir, "documents/landing-unchanged.md", [])({});
function rulings(rs: Ruling[]) {
	return (
		rs
			.map(
				(r) =>
					`${r.what}\n  Why: ${r.why}. Cost if wrong: ${r.cost}. Follows: ${r.follows}.`,
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
	const facts = form({
		sha: c.sha,
		base: c.base,
		path: c.checkout!.path,
		brief: c.brief,
		mandate: JSON.stringify(s.mandate, null, 2),
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
	const situation =
		c.scope !== "item"
			? c.scope
			: !history.length
				? "item"
				: history.at(-1)?.outcome === "pass"
					? "integration"
					: "rework";
	const task =
		c.phase === "diagnose"
			? diagnose({ facts, principle })
			: inputs[situation]!({ facts });
	return c.direction ? resume({ direction: c.direction, task }) : task;
}
export function agents(s: State): AgentDecl[] {
	if (s.cancelled) return [];
	return s.checks
		.filter((c) => c.phase === "verify" || c.phase === "diagnose")
		.map((c) => {
			const paused = s.holds.some((h) => h.item === c.item);
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
				(!s.cancelled || j.op.kind === "land" || j.op.kind === "remove") &&
				!s.holds.some((h) => h.job === j.key),
		)
		.map(({ key, op }) => ({
			key: effectKey(key),
			spec:
				op.kind === "read_repo"
					? { kind: op.kind, base: op.base, trunk: op.trunk }
					: { repo: s.repo!, op },
		}));
}
export function asks(s: State): Ask[] {
	if (s.cancelled || s.handover?.status !== "asking") return [];
	const h = s.handover,
		info = s.handoff!,
		trunk = s.repo!.trunk;
	return [
		{
			subject: subject("handover"),
			title: title({ trunk, sha: h.sha }).trim(),
			choices: ["accept", "reject"],
			basis: handover({
				sha: h.sha,
				trunk,
				base: s.repo!.base,
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
			}),
		},
	];
}
