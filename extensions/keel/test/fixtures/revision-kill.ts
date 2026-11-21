import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { openNodeSqliteStorage, type Storage } from "tau/durable";
import { openLiveRevision } from "./live-revision.ts";

const [root, file, boundary] = process.argv.slice(2);
assert.ok(root && file && (boundary === "triage" || boundary === "approval"));
const sqlite = await openNodeSqliteStorage(file);
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
					.some((w) => {
						if (w.type !== "task" || w.value.kind !== "keel.deliver")
							return false;
						const input = w.value.input as { lane?: string };
						return input?.lane === (boundary === "triage" ? "design" : "build");
					})
			) {
				writeSync(1, `kill:${boundary}\n`);
				process.kill(process.pid, "SIGKILL");
			}
			return result;
		};
	},
});
const s = await openLiveRevision(root, storage, false);
await s.answer(
	boundary === "triage" ? "triage/" : "revision/",
	boundary === "triage" ? "build" : "approve",
	boundary === "approval"
		? [{ text: "Prove framing before resuming the writer." }]
		: [],
);
throw Error(`No queued delivery committed after ${boundary}`);
