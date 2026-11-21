import { arr, int, obj, oneOf, str } from "tau/schema";
import { prose } from "../../kernel/lane.ts";
import { type Mandate, proofText, type RiderOrigin } from "./public.ts";

export const text = str({ minLength: 1 });
const observation = obj({ label: text, text });
export const auditSchema = obj({
	exists: text,
	gaps: arr(observation),
	contradictions: arr(observation),
});
export const ruleSchema = obj({ label: text, rule: text, probe: text });
export const checkSchema = obj({
	id: text,
	argv: arr(str(), { minItems: 1 }),
	timeoutMs: int({ minimum: 1, maximum: 2147483647 }),
});
export const seamSchema = obj({
	label: text,
	callersNow: text,
	callersLater: text,
	usage: text,
	signature: text,
	owner: text,
	dependencies: text,
});
const common = {
	intent: text,
	nodes: arr(ruleSchema),
	checks: arr(checkSchema, { minItems: 1 }),
};
export const smallDraft = obj(common);
export const reviewedDraft = obj({
	...common,
	done: text,
	seams: arr(seamSchema),
	never: text,
	tradeoffs: text,
	alternatives: text,
	settlements: arr(obj({ label: text, ruling: text })),
	riders: arr(
		obj({
			label: text,
			text,
			origin: oneOf(["evidence", "incidental", "seeded"]),
			disposition: oneOf(["bind", "open"]),
		}),
	),
	references: arr(obj({ label: text, source: text })),
});
export type Observation = { label: string; text: string };
export type Audit = {
	exists: string;
	gaps: Observation[];
	contradictions: Observation[];
};
export type Draft = Pick<Mandate, "intent" | "checks"> & {
	nodes: { label: string; rule: string; probe: string }[];
	done: string;
	seams: {
		label: string;
		callersNow: string;
		callersLater: string;
		usage: string;
		signature: string;
		owner: string;
		dependencies: string;
	}[];
	never: string;
	tradeoffs: string;
	alternatives: string;
	settlements: { label: string; ruling: string }[];
	riders: (Observation & {
		origin: RiderOrigin;
		disposition: "bind" | "open";
	})[];
	references: { label: string; source: string }[];
};
const dir = import.meta.dirname + "/../../prose/documents";
const seamText = prose(dir, "seam.md", [
	"callersNow",
	"callersLater",
	"usage",
	"signature",
	"owner",
	"dependencies",
]);
const rulingText = prose(dir, "ground-ruling.md", [
	"observation",
	"label",
	"ruling",
]);
const validText = (s: string) => !!s.trim();
const unique = (xs: string[]) => new Set(xs).size === xs.length;
function validLabels(xs: string[]) {
	return (
		unique(xs) &&
		xs.every((l) => validText(l) && l === l.trim() && !/[\r\n]/.test(l))
	);
}
const issueLabels = (a: Audit) =>
	[...a.gaps, ...a.contradictions].map((n) => n.label);
export function validAudit(a: Audit) {
	return (
		validText(a.exists) &&
		validLabels([...reserved, ...issueLabels(a)]) &&
		[...a.gaps, ...a.contradictions].every((n) => validText(n.text))
	);
}
const reserved = ["intent", "never", "tradeoffs", "alternatives"];
export const validRule = (n: Draft["nodes"][number]) =>
	validText(n.rule) && validText(n.probe);
export const validCheck = (c: Draft["checks"][number]) =>
	c.argv[0]?.trim() &&
	c.argv.every((a) => !a.includes("\0")) &&
	Number.isSafeInteger(c.timeoutMs) &&
	c.timeoutMs > 0 &&
	c.timeoutMs <= 2147483647;
const fenced = (v: string) =>
	/^```[^\s`]+\n[\s\S]*\S[\s\S]*\n```$/u.test(v.trim());
export const validSeam = (s: Draft["seams"][number]) =>
	Object.values(s).every(validText) && fenced(s.usage) && fenced(s.signature);
export const renderSeam = (s: Draft["seams"][number]) => seamText(s).trim();
export const seamFields = (s: Draft["seams"][number]) => ({
	"current callers": s.callersNow,
	"future callers": s.callersLater,
	"caller usage": s.usage,
	"types and signatures": s.signature,
	owner: s.owner,
	"allowed dependencies": s.dependencies,
});
export function changedFields(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
) {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
		(field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
	);
}
export function validSmall(d: Pick<Draft, "intent" | "nodes" | "checks">) {
	return (
		validText(d.intent) &&
		validLabels([
			"intent",
			...d.nodes.map((n) => n.label),
			...d.checks.map((c) => c.id),
		]) &&
		d.nodes.every(validRule) &&
		d.checks.length > 0 &&
		d.checks.every(validCheck)
	);
}
export function draftError(d: Draft, a: Audit) {
	const labels = [
		...reserved,
		...d.seams.map((n) => n.label),
		...d.nodes.map((n) => n.label),
		...d.checks.map((n) => n.id),
		...d.settlements.map((n) => n.label),
	];
	if (
		!validSmall(d) ||
		!validLabels([...labels, ...d.riders.map((r) => r.label)])
	)
		return "Use distinct labels, rules paired with probes and usable timed commands.";
	if (![d.done, d.never, d.tradeoffs, d.alternatives].every(validText))
		return "Give a done predicate, anti-criteria, tradeoffs and alternatives.";
	if (!d.seams.every(validSeam))
		return "Give both callers, fenced caller code and signatures in the project language, ownership and allowed dependencies for each seam.";
	const issues = issueLabels(a);
	if (
		issues.length !== d.settlements.length ||
		d.settlements.some((s) => !issues.includes(s.label) || !validText(s.ruling))
	)
		return "Propose one ruling under each Ground gap or contradiction label.";
	if (
		!unique(d.references.map((r) => r.label)) ||
		d.references.some(
			(r) =>
				!labels.includes(r.label) ||
				issues.includes(r.label) ||
				!validText(r.source),
		)
	)
		return "Cite one approved reference per determined node. Ground rulings belong to the owner.";
	if (
		d.riders.some(
			(r) =>
				!validText(r.text) ||
				!["evidence", "incidental", "seeded"].includes(r.origin) ||
				!["bind", "open"].includes(r.disposition),
		)
	)
		return "State each rider, its origin and whether it should bind or remain open.";
	return null;
}
type Node = {
	label: string;
	section: string;
	body: string;
	probe: string;
};
export function nodes(
	d: Draft,
	a: Audit,
	rulingLabel: "Proposed ruling" | "Ruling",
): Node[] {
	const node = (label: string, section: string, body: string, probe = "") => ({
		label,
		section,
		body,
		probe,
	});
	return [
		node("intent", "Intent", d.intent, d.done),
		...d.settlements.map((s) => {
			const gap = a.gaps.find((g) => g.label === s.label);
			return node(
				s.label,
				gap ? "Ground gap" : "Ground contradiction",
				rulingText({
					observation: (
						gap ?? a.contradictions.find((i) => i.label === s.label)!
					).text,
					label: rulingLabel,
					ruling: s.ruling,
				}).trim(),
			);
		}),
		...d.seams.map((s) => node(s.label, "Seam", renderSeam(s))),
		...d.nodes.map((n) => node(n.label, "Rule", n.rule, n.probe)),
		node("never", "Anti-criteria", d.never),
		...d.checks.map((c) => node(c.id, "Proof", proofText(c))),
	];
}
