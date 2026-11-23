import assert from "node:assert/strict";
import { openNodeSqliteStorage } from "tau/durable";
import { killAfterDelivery } from "./kill-after-delivery.ts";
import { openLiveRevision } from "./live-revision.ts";

const [root, file, boundary] = process.argv.slice(2);
assert.ok(root && file && (boundary === "triage" || boundary === "approval"));
const lane = boundary === "triage" ? "design" : "build";
const storage = killAfterDelivery(
	await openNodeSqliteStorage(file),
	boundary,
	(input) => (input as { lane?: string } | null)?.lane === lane,
);
const s = await openLiveRevision(root, storage, false);
await s.answer(
	boundary === "triage" ? "triage/" : "revision/",
	boundary === "triage" ? "build" : "approve",
	boundary === "approval"
		? [{ text: "Prove framing before resuming the writer." }]
		: [{ text: "Keep one framing scheme for the book and its reader." }],
);
throw Error(`No queued delivery committed after ${boundary}`);
