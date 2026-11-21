import type { JsonObject } from "tau/durable";
import { createKernel } from "./kernel/kernel.ts";
import type { EffectRunner } from "./kernel/tasks.ts";
import { lanes, tools } from "./lanes/index.ts";
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
import { explorerDispatch, runDesignDispatch } from "./roles/dispatch.ts";

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
	return createKernel({
		lanes,
		tools,
		runEffect: (input, ctx, owner) =>
			input.spec.kind === "arena_dispatch"
				? runDesignDispatch(input, ctx, owner)
				: runEffect(input, ctx, owner),
		dispatch: explorerDispatch,
		plainTools: principleTools,
		sections: principleSections,
		input: principleInputs,
	});
}
