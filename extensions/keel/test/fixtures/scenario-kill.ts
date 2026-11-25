import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { type JsonObject, openNodeSqliteStorage } from "tau/durable";
import { runRepoEffect } from "../../src/workflow.ts";
import { openScenario } from "./scenario.ts";

const [root, file, point] = process.argv.slice(2);
assert.ok(root && file && (point === "publication" || point === "landing"));
function kill() {
	writeSync(1, `kill:${point}\n`);
	process.kill(process.pid, "SIGKILL");
}
// The same runner, durable store and Git repository as production. Stop before
// checkout touches disk, or after Git acknowledges CAS but before the kernel
// can acknowledge the effect. Restart has no access to these in-memory results.
const s = await openScenario(
	root,
	await openNodeSqliteStorage(file),
	point === "publication" ? "through-publish" : "through-land",
	async (input, ctx, runtime) => {
		const op = input.spec.op as JsonObject | undefined;
		if (point === "publication" && op?.kind === "checkout") kill();
		const result = await runRepoEffect(input, ctx, runtime);
		if (point === "landing" && op?.kind === "land" && result.kind === "landed")
			kill();
		return result;
	},
);
if (point === "publication") await s.start();
else await s.assertHistory({ publishes: 1, reviews: 0, landings: 0 });
await s.settle();
throw Error(`Workflow settled without reaching ${point} kill point`);
