import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createSqliteTelemetry } from "@earendil-works/chord/telemetry-sqlite";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { StoredMetric } from "@earendil-works/pi-telemetry";
import { flow } from "./extensions.js";
import { type Running, start, until } from "./helpers.js";

const extension = defineExtension({
	name: "measure",
	tools: [
		defineTool({
			name: "measure",
			description: "Record a measurement.",
			parameters: obj({ run: str() }),
			execute: async ({ run }, _api, context) => {
				const latency = context.telemetry.metrics?.histogram(
					"measure.latency",
					{ unit: "ms" },
				);
				latency?.record(12, { mode: "test", local: true, attempt: 1 });
				latency?.record(NaN, { mode: "test", local: true, attempt: 1 });
				latency?.record(Infinity, { mode: "test", local: true, attempt: 1 });
				context.telemetry.setAttributes({
					"measure.run": run,
					"measure.mode": "test",
				});
				return { output: [{ type: "text", text: "recorded" }] };
			},
		}),
	],
});
const source = () => ({
	modules: { measure: { extension }, flow },
	failures: [],
});
const file = (s: Running) =>
	path.join(s.home, "projects", "p", "telemetry.sqlite");

async function bind(
	s: Running,
	project = "p",
	extensions = ["measure", "flow"],
) {
	const reply = await s.call("bind", { project, workdir: s.home, extensions });
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
}

async function run(
	s: Running,
	requestId: string,
	tool: string,
	args: JsonObject,
	agent: { model: string } | { workflow: string } = { model: "faux/a" },
) {
	const created = await s.call("create", { project: "p", ...agent });
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const { conversation } = created.body.result;
	s.faux.setResponses([
		fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" }),
		({ messages }) => {
			const result = messages.find((message) => message.role === "toolResult");
			assert.equal(result?.toolName, tool);
			assert.equal(result?.isError, false, JSON.stringify(result?.content));
			return fauxAssistantMessage("Done.");
		},
	]);
	const submitted = await s.call("input", {
		project: "p",
		conversation,
		text: requestId,
		requestId,
	});
	assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
	await until("the run settles", async () => {
		const { status, body } = await s.call("conversations", { project: "p" });
		assert.equal(status, 200, JSON.stringify(body));
		const item = body.result.items.find(
			(item: { conversation: number }) => item.conversation === conversation,
		);
		assert.ok(item);
		if (item.state === "running") return false;
		assert.equal(item.state, "idle");
		return true;
	});
}

test("a tool recording nonfinite measurements does not fail the tool or the run", async () => {
	const s = await start({ source });
	try {
		await bind(s);
		await run(s, "one", "measure", { run: "one" });
	} finally {
		await s.close();
	}
});

test("a corrupt telemetry file logs its failure but does not stop the project", async (t) => {
	let s = await start();
	try {
		await bind(s, "p", []);
		await s.close();
		await writeFile(file(s), "not a database".repeat(32));
		const stderr: string[] = [];
		t.mock.method(process.stderr, "write", (chunk: string) => {
			stderr.push(String(chunk));
			return true;
		});
		s = await s.restart();
		const listed = await s.call("conversations", { project: "p" });
		assert.equal(listed.status, 200, JSON.stringify(listed.body));
		assert.deepEqual(listed.body.result.items, []);
		assert.ok(
			stderr.some((line) => /^tau: telemetry p: .+/m.test(line)),
			stderr.join(""),
		);
	} finally {
		await s.close();
	}
});

test("only the accepted answer records the wait to its continuation", async () => {
	let now = Date.now();
	const s = await start({ source, now: () => now });
	try {
		await bind(s);
		const options = await s.call("setOptions", {
			project: "p",
			extension: "flow",
			patch: { designer: "faux/a" },
		});
		assert.equal(options.status, 200, JSON.stringify(options.body));
		await run(s, "ask", "ask", { key: "wait" }, { workflow: "flow" });
		const decision = "flow:wait#1";
		const open = await s.call("decision", { project: "p", decision });
		assert.equal(open.status, 200, JSON.stringify(open.body));
		const { basis } = open.body.result.decision;
		const input = {
			project: "p",
			decision,
			basis,
			choice: "approve",
			annotations: [],
		};
		now += 500;
		const refused = await s.call("answer", { ...input, choice: "unknown" });
		assert.equal(refused.body.refused?.code, "unknown_choice");
		now += 734;
		const accepted = await s.call("answer", input);
		assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
		assert.equal(accepted.body.result.repeated, false);
		now += 500;
		const repeated = await s.call("answer", input);
		assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
		assert.equal(repeated.body.result.repeated, true);
	} finally {
		await s.close();
	}
	const db = await openNodeSqliteDatabase(file(s));
	try {
		const adapter = await createSqliteTelemetry(db);
		try {
			const items = await adapter.findMetrics({ name: "tau.decision.wait" });
			assertWait(items);
		} finally {
			await adapter.close();
		}
	} finally {
		await db.close();
	}
});

function assertWait(items: readonly StoredMetric[]) {
	assert.equal(items.length, 1, "one series holds the accepted answer only");
	const [row] = items;
	assert.ok(row);
	const { intervalMs, ...measurement } = row;
	assert.equal(intervalMs % 10_000, 0);
	assert.deepEqual(measurement, {
		name: "tau.decision.wait",
		kind: "histogram",
		unit: "ms",
		attributes: { task: "flow.approved", choice: "approve" },
		count: 1,
		sum: 1234,
		min: 1234,
		max: 1234,
	});
}
