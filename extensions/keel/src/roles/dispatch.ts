import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRef, prose } from "tau";
import { CodingTools } from "tau/durable";
import type { DispatchJob } from "../dispatch/index.ts";
import type { createKernel } from "../kernel/kernel.ts";
import type { EffectRunner } from "../kernel/tasks.ts";
import { projectPrinciplesText } from "../principles/catalog.ts";
import { dispatchBounds, options, ROLES, type RoleName } from "./index.ts";

const dir = import.meta.dirname + "/../prose";
const explorer = prose(dir, "roles/explorer.md", [])({});
const evidence = prose(dir, "inputs/explorer/evidence.md", ["record"]);
const candidate = prose(dir, "roles/arena-candidate.md", [])({});
const judge = prose(dir, "roles/arena-judge.md", [])({});
const challenger = prose(dir, "roles/arena-challenger.md", [])({});
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
	resolve({ role, options, cwd, view }, { seat: requested }) {
		const explorerRole = explorerSeat(role);
		if (!explorerRole || requested !== explorerRole) return;
		const design = view("design");
		const build = view("build") as { rulings: unknown } | null;
		const queue = view("queue") as {
			patternRulings: unknown;
			investigation: unknown;
		} | null;
		const record = JSON.stringify(
			{
				design,
				rulings: build?.rulings ?? [],
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
						const instructions = prose(
							dir,
							"roles/design-prototype.md",
							[],
						)({});
						const scratch = await mkdtemp(join(tmpdir(), "keel-prototype-"));
						return seat(role, model, scratch, instructions);
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
