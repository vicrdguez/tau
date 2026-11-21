import type { JsonObject } from "tau/durable";
import { createKernel } from "./kernel/kernel.ts";
import { readViews } from "./kernel/routing.ts";
import { project } from "./kernel/storage.ts";
import type { EffectRunner } from "./kernel/tasks.ts";
import { lanes, tools } from "./lanes/index.ts";
import { workPrinciples } from "./lanes/build/public.ts";
import { authorityIndex, reviewedHistory } from "./lanes/design/public.ts";
import { queueLane } from "./lanes/queue/index.ts";
import { type SweepHistory, sweepConfigured } from "./lanes/queue/public.ts";
import {
	principleInputs,
	principleSections,
	principleTools,
} from "./principles/index.ts";
import {
	converge,
	nodeExec,
	type RepoInfo,
	type RepoOp,
	readRepo,
} from "./repo/index.ts";
import {
	explorerDispatch,
	runDesignDispatch,
	sweepDispatch,
} from "./roles/dispatch.ts";
import { options } from "./roles/index.ts";

const history = new Map(
	lanes
		.filter((lane) => lane.scope === "conversation")
		.map((lane) => [lane.name, lane]),
);
const projectViews = new Map([[queueLane.name, queueLane]]);
const sweep = sweepDispatch(async (tx) => {
	const queue = (await readViews(tx, projectViews, null))("queue") as Pick<
		SweepHistory,
		"patternRulings" | "priorFindings"
	>;
	const works = await Promise.all(
		(await project(tx)).works.map(async (work) => {
			const view = await readViews(tx, history, work);
			const { landedAt } = view("verify") as { landedAt: number | null };
			return landedAt === null ? [] : [{ work, view, landedAt }];
		}),
	);
	const landed = works.flat().sort((a, b) => a.landedAt - b.landedAt);
	return {
		...queue,
		authority: landed.flatMap(({ work, view }) => {
			const reviewed = reviewedHistory(view("design"));
			return reviewed ? [authorityIndex(work, reviewed)] : [];
		}),
		samples: landed
			.flatMap(({ work, view }) =>
				workPrinciples(view("build")).map((sample) => ({ work, ...sample })),
			)
			.slice(-30),
	};
});

// Specs are authored by lane declarations and committed by the kernel, not supplied by agents.
// Discovery pins the repository before the *next* operation is planned. Never rediscover it on retry.
export const runRepoEffect: EffectRunner = async ({ root, spec }) => {
	if (spec.kind === "read_repo") {
		const { base, trunk } = spec;
		if (typeof base !== "string" || typeof trunk !== "string")
			throw new Error(
				"Repository discovery needs its configured base and trunk",
			);
		return {
			kind: "repo",
			repo: await readRepo(nodeExec, root, { base, trunk }),
		};
	}
	const { repo, op } = spec as { repo: RepoInfo; op: RepoOp };
	if (!repo || !op) throw new Error("Expected a stored repository operation");
	// The repo API exposes JSON arrays as readonly. The durable API owns the returned value.
	return (await converge(nodeExec, repo, op)) as JsonObject;
};
export function createWorkflow(runEffect: EffectRunner = runRepoEffect) {
	const kernel = createKernel({
		lanes,
		tools,
		runEffect: (input, ctx, owner) => {
			if (input.spec.kind === "arena_dispatch")
				return runDesignDispatch(input, ctx, owner);
			if (input.spec.kind === "sweep") return sweep(input, ctx, owner);
			return runEffect(input, ctx, owner);
		},
		dispatch: explorerDispatch,
		plainTools: principleTools,
		sections: principleSections,
		input: principleInputs,
	});
	return {
		...kernel,
		options: {
			...options,
			async set(...[tx, value]: Parameters<typeof options.set>) {
				const before = (await options.get(tx)).sweep_minutes;
				await options.set(tx, value);
				if (before !== value.sweep_minutes && (await project(tx)).works.length)
					// The task uses its durable clock on admission. This event opens no decision.
					await kernel.transact(tx, sweepConfigured, 0);
			},
		},
	};
}
