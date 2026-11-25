import assert from "node:assert/strict";
import { openNodeSqliteStorage } from "tau/durable";
import { killAfterDelivery } from "./kill-after-delivery.ts";
import { openReview } from "./mandate-scenario.ts";

const [root, file] = process.argv.slice(2);
assert.ok(root && file);
const storage = killAfterDelivery(
	await openNodeSqliteStorage(file),
	"revision-owed",
);
const s = await openReview(root, storage, false);
await s.rework();
throw Error("No designer delivery was committed after the round's answer");
