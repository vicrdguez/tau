import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRef, prose } from "tau";
import { CodingTools } from "tau/durable";
import type { DispatchJob } from "../dispatch/index.ts";
import type { createKernel } from "../kernel/kernel.ts";
import type { EffectRunner } from "../kernel/tasks.ts";
import { workRulings } from "../lanes/build/public.ts";
import { reviewedMandate } from "../lanes/design/public.ts";
import { projectPrinciplesText } from "../principles/catalog.ts";
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
		const design = view("design");
		const queue = view("queue") as {
			patternRulings: unknown;
			investigation: unknown;
		} | null;
		const record = JSON.stringify(
			{
				design,
				rulings: workRulings(view("build")),
				priorWorks: priorWorks.flatMap(({ work, view }) => {
					const mandate = reviewedMandate(view("design"));
					return mandate
						? [{ work, mandate, rulings: workRulings(view("build")) }]
						: [];
				}),
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
