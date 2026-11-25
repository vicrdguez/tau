import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { openNodeSqliteStorage, type Storage } from "tau/durable";
import { fauxAssistantMessage, fauxToolCall } from "tau/testing";
import { Toy, toy } from "../toy.ts";

const [file, point] = process.argv.slice(2);
assert.ok(file && (point === "create" || point === "publish"));
const sqlite = await openNodeSqliteStorage(file);
let armed = false;
function kill() {
	writeSync(1, `committed:${point}\n`);
	process.kill(process.pid, "SIGKILL");
}

// Intercept SQLite's acknowledgement, not the lane or tool. Only examine batches
// SQLite actually stored, before returning their commit to the harness.
const storage = new Proxy(sqlite, {
	get(target, key) {
		if (key !== "commit") {
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		}
		return async (...args: Parameters<Storage["commit"]>) => {
			const result = await target.commit(...args);
			if (armed) {
				for (const write of args[0].slice(0, result.stored).flat()) {
					if (point === "create" && write.type === "conversation") kill();
					if (point === "publish" && write.type === "document.change") {
						const doc = await target.document(write.id, "current", ctx);
						if (
							doc &&
							doc.record.kind === Toy.kind &&
							doc.value.publications === 1
						)
							kill();
					}
				}
			}
			return result;
		};
	},
});
const x = await toy({ storage });
armed = point === "create";
await x.send("agent");
if (point === "publish") {
	armed = true;
	x.provider.setResponses([
		fauxAssistantMessage([fauxToolCall("publish", {})], {
			stopReason: "toolUse",
		}),
	]);
	x.harness.resume();
	await x.finish("keel.deliver");
	const [worker] = await x.agents();
	assert.ok(worker);
	await (await x.harness.conversation(worker, ctx))?.waitForIdle(ctx);
}
throw new Error(`No ${point} commit reached the kill point`);
