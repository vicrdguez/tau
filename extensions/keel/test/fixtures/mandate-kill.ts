import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { openNodeSqliteStorage, type Storage } from "tau/durable";
import { openReview } from "./mandate-scenario.ts";

const [root, file] = process.argv.slice(2);
assert.ok(root && file);
const sqlite = await openNodeSqliteStorage(file);
// Kill after SQLite commits the answer continuation's designer delivery,
// before the harness can run it. The parent reopens the file without this hook.
const storage = new Proxy(sqlite, {
	get(target, key) {
		if (key !== "commit") {
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		}
		return async (...args: Parameters<Storage["commit"]>) => {
			const result = await target.commit(...args);
			if (
				args[0]
					.slice(0, result.stored)
					.flat()
					.some((w) => w.type === "task" && w.value.kind === "keel.deliver")
			) {
				writeSync(1, "kill:revision-owed\n");
				process.kill(process.pid, "SIGKILL");
			}
			return result;
		};
	},
});
const s = await openReview(root, storage, false);
await s.rework();
throw Error("No designer delivery was committed after the round's answer");
