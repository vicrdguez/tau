import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRef, prose } from "tau";
import { CodingTools, type Tx } from "tau/durable";
import type { DispatchJob } from "../dispatch/index.ts";
import type { createKernel } from "../kernel/kernel.ts";
import type { EffectRunner } from "../kernel/tasks.ts";
import { workRulings } from "../lanes/build/public.ts";
import {
	authorityIndex,
	explorerDesign,
	reviewedHistory,
} from "../lanes/design/public.ts";
import type { SweepFinding, SweepHistory } from "../lanes/queue/public.ts";
import { projectPrinciplesText } from "../principles/catalog.ts";
import { principleUsage } from "../principles/index.ts";
import { replyJson } from "../reply-json.ts";
import { nodeExec, readRepo } from "../repo/index.ts";
import { dispatchBounds, options, ROLES, type RoleName } from "./index.ts";

const dir = import.meta.dirname + "/../prose";
const explorer = prose(dir, "roles/explorer.md", [])({});
const evidence = prose(dir, "inputs/explorer/evidence.md", ["record"]);
const candidate = prose(dir, "roles/arena-candidate.md", [])({});
const judge = prose(dir, "roles/arena-judge.md", [])({});
const challenger = prose(dir, "roles/arena-challenger.md", [])({});
const prototype = prose(dir, "roles/design-prototype.md", ["directory"]);
const challengerPrinciples = prose(
	dir,
	"inputs/design/challenger-principles.md",
	["principles"],
);

const explorerSeats = {
	designer: "design_explorer",
	worker: "build_explorer",
	investigator: "queue_explorer",
} as const satisfies Partial<Record<RoleName, RoleName>>;
function explorerSeat(role: RoleName) {
	return Object.hasOwn(explorerSeats, role)
		? explorerSeats[role as keyof typeof explorerSeats]
		: undefined;
}

function seat(
	role: RoleName,
	model: string,
	cwd: string | null,
	instructions: string,
) {
	return {
		model: modelRef(model),
		cwd,
		instructions,
		extensions: [CodingTools],
		tools: ROLES[role].tools,
	};
}

export const explorerDispatch: NonNullable<
	Parameters<typeof createKernel>[0]["dispatch"]
> = {
	roles: ["designer", "worker", "investigator"],
	history: ["design", "build"],
	resolve({ role, options, cwd, view, priorWorks }, { seat: requested }) {
		const explorerRole = explorerSeat(role);
		if (!explorerRole || requested !== explorerRole) return;
		const design = explorerDesign(view("design"));
		const queue = view("queue") as {
			patternRulings: unknown;
			investigation: unknown;
		} | null;
		const history = priorWorks.flatMap(({ work, view }) => {
			const prior = reviewedHistory(view("design"));
			return prior ? [{ work, ...prior, view }] : [];
		});
		const record = JSON.stringify(
			{
				design,
				rulings: design ? workRulings(view("build")) : [],
				priorWorks: history.slice(-3).map(({ work, mandate, nodes, view }) => ({
					work,
					...(mandate
						? { mandate, rulings: workRulings(view("build")) }
						: { revisionNodes: nodes }),
				})),
				earlierWorks: history
					.slice(0, -3)
					.map((prior) => authorityIndex(prior.work, prior)),
				patternRulings: queue?.patternRulings ?? [],
				investigation:
					role === "investigator" ? (queue?.investigation ?? null) : null,
			},
			null,
			2,
		);
		return seat(
			explorerRole,
			options[explorerRole] ?? options[ROLES[explorerRole].lane],
			cwd,
			explorer + "\n\n" + evidence({ record }),
		);
	},
};

const sweepRole = prose(dir, "roles/sweeper.md", [
	"revision",
	"authority",
	"usage",
	"priorFindings",
]);
const sweepInput = prose(dir, "inputs/queue/sweep.md", [])({});

function sweepFinding(value: unknown): value is SweepFinding {
	return (
		value !== null &&
		typeof value === "object" &&
		"text" in value &&
		typeof value.text === "string" &&
		Boolean(value.text.trim()) &&
		"report" in value &&
		typeof value.report === "string" &&
		Boolean(value.report.trim()) &&
		(!("pattern" in value) ||
			value.pattern === null ||
			typeof value.pattern === "string") &&
		(!("principle" in value) || typeof value.principle === "boolean") &&
		!(
			"principle" in value &&
			value.principle &&
			"pattern" in value &&
			value.pattern
		)
	);
}

export function sweepDispatch(
	readHistory: (tx: Tx) => Promise<SweepHistory>,
): EffectRunner {
	return async ({ root }, ctx, owner) => {
		const [result] = await owner.dispatch(
			async (tx) => {
				const opts = await options.read(tx);
				return {
					...dispatchBounds(opts),
					// Dispatch calls resolve only for a new plan. The child's evidence and
					// model stay pinned even if trunk advances while the server is down.
					async resolve(tx) {
						const repo = await readRepo(nodeExec, root, opts);
						const { authority, samples, patternRulings, priorFindings } =
							await readHistory(tx);
						return seat(
							"sweeper",
							opts.sweeper ?? opts.queue,
							root,
							sweepRole({
								revision: repo.trunkHead ?? repo.baseHead,
								authority: JSON.stringify({
									earlierWorks: authority,
									patternRulings,
								}),
								usage: JSON.stringify(await principleUsage(tx, samples)),
								priorFindings: JSON.stringify(priorFindings),
							}),
						);
					},
				};
			},
			[{ seat: "sweeper", question: sweepInput }],
			ctx,
		);
		if (!result?.answer)
			throw new Error(result?.error ?? "Sweep returned no answer.");
		const findings = replyJson(result.answer);
		if (
			!Array.isArray(findings) ||
			findings.length > 8 ||
			!findings.every(sweepFinding)
		)
			throw new Error(
				"Sweep must return at most eight findings with text and evidence.",
			);
		return { findings };
	};
}

type DesignJob = DispatchJob & { model: string };
function designJob(value: unknown): value is DesignJob {
	return (
		!!value &&
		typeof value === "object" &&
		"seat" in value &&
		typeof value.seat === "string" &&
		"question" in value &&
		typeof value.question === "string" &&
		"model" in value &&
		typeof value.model === "string"
	);
}

export const runDesignDispatch: EffectRunner = async (
	{ root, spec },
	ctx,
	owner,
) => {
	if (!Array.isArray(spec.jobs) || !spec.jobs.every(designJob))
		throw new Error("Invalid design dispatch plan.");
	const results = await owner.dispatch(
		async (tx) => ({
			...dispatchBounds(await options.read(tx)),
			async resolve(_tx, _caller, { seat: role, model }) {
				switch (role) {
					case "arena_seat_1":
					case "arena_seat_2":
					case "arena_seat_3":
						return seat(role, model, root, candidate);
					case "arena_judge":
						return seat(role, model, root, judge);
					case "arena_challenger":
						return seat(
							role,
							model,
							root,
							challenger +
								"\n\n" +
								challengerPrinciples({
									principles: projectPrinciplesText(root),
								}),
						);
					case "design_prototype": {
						// Resolve only for a new plan. The child's stored cwd survives replay.
						const directory = await mkdtemp(join(tmpdir(), "keel-prototype-"));
						return seat(role, model, directory, prototype({ directory }));
					}
				}
			},
		}),
		spec.jobs,
		ctx,
	);
	return {
		results: results.map(({ conversation, ...rest }) => ({
			...rest,
			conversation: String(conversation),
		})),
	};
};
