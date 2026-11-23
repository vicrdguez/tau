import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { StoredMetric, StoredTrace } from "@earendil-works/pi-telemetry";
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
				const nonfinite =
					context.telemetry.metrics?.histogram("measure.nonfinite");
				nonfinite?.record(NaN);
				nonfinite?.record(Infinity);
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

test("a tool records metrics and trace attributes across restart without failing on nonfinite values", async () => {
	let s = await start({ source });
	try {
		await bind(s);
		await bind(s, "other", []);
		await run(s, "one", "measure", { run: "one" });
		await run(s, "two", "measure", { run: "two" });
		s = await s.restart();
		await checkMeasurements(s);
		await checkTraces(s);
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
		for (const [call, fields] of [
			["metrics", { name: "unknown" }],
			["traces", {}],
			["trace", { traceId: "unknown" }],
		] as const) {
			const reply = await s.call(call, { project: "p", ...fields });
			assert.equal(reply.status, 409, call);
			assert.equal(reply.body.refused?.code, "telemetry_unavailable", call);
		}
	} finally {
		await s.close();
	}
});

test("only the accepted answer records the wait to its continuation", async () => {
	let now = Date.now();
	let s = await start({ source, now: () => now });
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
		s = await s.restart();
		const items = await metrics(s, { name: "tau.decision.wait" });
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
	} finally {
		await s.close();
	}
});

async function metrics(s: Running, filters: object): Promise<StoredMetric[]> {
	const reply = await s.call("metrics", { project: "p", ...filters });
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
	return reply.body.result.items;
}

async function checkMeasurements(s: Running) {
	const name = "measure.latency";
	const attributes = { mode: "test", local: true, attempt: 1 };
	const measured = await metrics(s, { name, attributes });
	assert.ok(
		measured.length > 0,
		"the tool measurements persist across restart",
	);
	for (const item of measured) {
		assert.equal(item.name, name);
		assert.equal(item.kind, "histogram");
		assert.equal(item.unit, "ms");
		assert.deepEqual(item.attributes, attributes);
		assert.equal(item.min, 12);
		assert.equal(item.max, 12);
	}
	assert.equal(
		measured.reduce((count, item) => count + item.count, 0),
		2,
	);
	assert.equal(
		measured.reduce((sum, item) => sum + item.sum, 0),
		24,
	);
	const [row] = measured;
	assert.ok(row);
	const interval = row.intervalMs;
	assert.deepEqual(
		await metrics(s, { name, startMin: interval, startMax: interval }),
		measured.slice(0, 1),
	);
	assert.deepEqual(await metrics(s, { name, attributes: { local: 1 } }), []);
	for (const name of [
		"pi.ai.cost",
		"pi.ai.tokens",
		"pi.ai.request.duration",
		"pi.durable.phase.duration",
	])
		assert.ok((await metrics(s, { name })).length > 0, name);
}

async function checkTraces(s: Running) {
	const attributes = { "measure.mode": "test" };
	const traces = async (
		filters: object,
	): Promise<{ items: StoredTrace[]; next?: string }> => {
		const reply = await s.call("traces", { project: "p", ...filters });
		assert.equal(reply.status, 200, JSON.stringify(reply.body));
		return reply.body.result;
	};
	const all = (await traces({ attributes })).items;
	assert.equal(all.length, 2, "the tool spans survive restart");
	assert.deepEqual(
		all
			.flatMap(({ spans }) =>
				spans.flatMap(({ attributes }) => attributes["measure.run"] ?? []),
			)
			.sort(),
		["one", "two"],
	);
	assert.ok(
		all.every(({ spans }) => spans.length > 1),
		"a match returns each whole trace",
	);
	const first = await traces({ attributes, limit: 1, errors: false });
	assert.deepEqual(first.items, all.slice(0, 1));
	assert.ok(first.next, "a second page is available");
	const second = await traces({ cursor: first.next, limit: 1 });
	assert.deepEqual(second, { items: all.slice(1) });

	const [firstTrace] = all;
	assert.ok(firstTrace);
	const [head] = firstTrace.spans;
	assert.ok(head);
	assert.ok(
		(
			await traces({
				name: head.name,
				startMin: head.startedMs,
				startMax: head.startedMs,
			})
		).items.some(({ traceId }) => traceId === firstTrace.traceId),
	);
	assert.deepEqual(await traces({ attributes, errors: true }), { items: [] });

	for (const [call, fields] of [
		["traces", { project: "other" }],
		["traces", { attributes: { "measure.mode": "other" } }],
		["traces", { name: head.name }],
		["traces", { errors: true }],
	] as const) {
		const project = "project" in fields ? fields.project : "p";
		const reply = await s.call(call, {
			...fields,
			project,
			cursor: first.next,
		});
		assert.equal(reply.status, 400, JSON.stringify(reply.body));
		assert.equal(reply.body.refused?.code, "bad_cursor");
	}
	const paged = await s.call("conversations", { project: "p", limit: 1 });
	assert.equal(paged.status, 200);
	const otherCall = paged.body.result.next;
	assert.ok(otherCall);
	const wrongCall = await s.call("traces", { project: "p", cursor: otherCall });
	assert.equal(wrongCall.status, 400);
	assert.equal(wrongCall.body.refused?.code, "bad_cursor");
	const valid = await s.call("trace", {
		project: "p",
		traceId: firstTrace.traceId,
	});
	assert.equal(valid.status, 200, JSON.stringify(valid.body));
	assert.deepEqual(valid.body.result, { trace: all[0] });
	const unknown = await s.call("trace", { project: "p", traceId: "unknown" });
	assert.equal(unknown.status, 404);
	assert.equal(unknown.body.refused?.code, "unknown_trace");
}
