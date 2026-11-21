import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, openNodeSqliteStorage } from "tau/durable";
import { options } from "../../src/roles/index.ts";
import { runRepoEffect } from "../../src/workflow.ts";
import { openScenario } from "./scenario.ts";

const [root, file, time] = process.argv.slice(2);
assert.ok(root && file && time);
const s = await openScenario(
	root,
	await openNodeSqliteStorage(file),
	"rework",
	async (input, ctx, owner) => {
		const result = await runRepoEffect(input, ctx, owner);
		if (
			(input.spec.op as JsonObject | undefined)?.kind === "land" &&
			result.kind === "landed"
		) {
			writeSync(1, "kill:landing\n");
			process.kill(process.pid, "SIGKILL");
		}
		return result;
	},
	() => Number(time),
);
await s.store.harness.commit(
	(tx) =>
		options.patch(tx, { sweep_minutes: 1, sweeper: "sweep-fixture/sweeper" }),
	ctx,
);
await s.start();
await s.settle();
throw new Error("No landing kill point");
