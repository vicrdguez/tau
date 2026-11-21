import { arr, int, obj, oneOf, opt, str } from "tau/schema";
import { defineLaneTool } from "../../kernel/lane.ts";
import { nodeExec, readCheckoutHead } from "../../repo/index.ts";
import type { Intake } from "./public.ts";
import { classes, type QueueBuildView } from "./state.ts";

const text = str({ minLength: 1 });
const finding = int({ minimum: 1 });
const sources = {
	designer: "designer",
	coordinator: "coordinator",
	worker: "worker",
	verifier: "verifier",
	diagnoser: "diagnoser",
	investigator: "investigator",
} as const satisfies Record<string, Intake["source"]>;
type Filer = keyof typeof sources;

export const queueTools = [
	defineLaneTool({
		lane: "queue",
		name: "file_finding",
		roles: [
			"designer",
			"coordinator",
			"worker",
			"verifier",
			"diagnoser",
			"investigator",
		],
		gate: "standing",
		description:
			"File a finding with evidence and affected Mandate nodes. Only a worker or item verifier may block its own item. A designer can file with source owner on the owner's behalf. Filing never chooses how to resolve it.",
		parameters: obj({
			text,
			report: opt(text),
			nodes: opt(arr(text)),
			blocking: opt(oneOf([true, false])),
			source: opt(oneOf(["agent", "owner"])),
			edgeCase: opt(obj({ failure: text, likelihood: text, cost: text })),
		}),
		terminate: ({ blocking }) => blocking === true,
		observe: async (_, self, _ctx, view) => ({
			sha:
				self.cwd === null ? null : await readCheckoutHead(nodeExec, self.cwd),
			item:
				self.role === "worker"
					? ((view("build") as QueueBuildView | null)?.itemOf(self.agent) ??
						null)
					: self.role === "verifier" &&
							self.agent.startsWith("verify/") &&
							self.agent !== "verify/full"
						? self.agent.slice("verify/".length)
						: null,
		}),
		event: (args, facts, self) => {
			const intake = {
				work: self.work,
				item: facts.item,
				sha: facts.sha,
				source:
					args.source === "owner" && self.role === "designer"
						? "owner"
						: sources[self.role as Filer],
				text: args.text,
				report: args.report ?? null,
				nodes: args.nodes ?? [],
				edgeCase: args.edgeCase ?? null,
				pattern: null,
				blocking: args.blocking ?? false,
			} satisfies Intake;
			return {
				kind: "intake",
				...intake,
				requestedOwner: args.source === "owner",
			};
		},
	}),
	defineLaneTool({
		lane: "queue",
		name: "report_investigation",
		roles: ["investigator"],
		description:
			"Report the investigation with evidence, estimate, decision cause and recommendation. Name the approved reference when determined and binding nodes when the Mandate is wrong. Link related evidence with sameAs.",
		parameters: obj({
			finding,
			classification: oneOf(classes),
			nodes: opt(arr(text)),
			evidence: text,
			size: text,
			recommendation: oneOf([
				"build",
				"defer",
				"drop",
				"bless",
				"revoke",
				"no_action",
			]),
			cause: opt(text),
			sameAs: opt(finding),
			reference: opt(text),
		}),
		terminate: true,
		event: (args) => ({
			kind: "investigated",
			finding: args.finding,
			classification: args.classification,
			nodes: args.nodes ?? [],
			evidence: args.evidence,
			size: args.size,
			recommendation: args.recommendation,
			cause: args.cause ?? "",
			sameAs: args.sameAs ?? null,
			reference: args.reference ?? null,
		}),
	}),
] as const;
