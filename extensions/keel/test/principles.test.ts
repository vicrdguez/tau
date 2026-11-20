import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type Conversation, configure } from "tau/durable";
import { obj, str } from "tau/schema";
import { fauxAssistantMessage, fauxToolCall } from "tau/testing";
import { defineLaneTool } from "../src/kernel/lane.ts";
import {
	indexFor,
	principleInputs,
	principleTools,
} from "../src/principles/index.ts";
import { toy } from "./toy.ts";

async function checkout(t: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "keel-principles-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const dir = join(cwd, ".keel/principles");
	await mkdir(dir, { recursive: true });
	const put = (
		name: string,
		description: string,
		bindings: string,
		body: string,
	) =>
		writeFile(
			join(dir, `${name}.md`),
			`---\ndescription: "${description}"\n${bindings}---\n\n${body}\n`,
		);
	return { cwd, put };
}
test("the full index follows offered tools, keeps Keel then project order, and rereads descriptions from this checkout", async (t) => {
	const { cwd, put } = await checkout(t);
	await put("zeta", "Last statement.", "", "Secret body.");
	await put("alpha", "First statement.", "", "Another body.");
	assert.equal(indexFor(cwd, []), undefined);
	const index = () => indexFor(cwd, [{ name: "principle" }])!;
	const first = index();
	assert.match(
		first,
		/attack-the-premise[\s\S]+type-system-discipline[\s\S]+alpha: First statement\.[\s\S]+zeta: Last statement\./,
	);
	assert.doesNotMatch(first, /Secret body|Another body/);
	assert.equal(index(), first);
	await put("zeta", "New statement.", "", "Changed.");
	assert.match(index(), /alpha: First statement\.[\s\S]+zeta: New statement\./);
	assert.doesNotMatch(index(), /Last statement/);
});
test("role and path bindings deliver bodies, while the verifier sees all project descriptions", async (t) => {
	const { cwd, put } = await checkout(t);
	await put(
		"money",
		"Review rounding.",
		'paths:\n  - "src/money/**"\n',
		"Apply the cent rule.",
	);
	await put(
		"coordinate",
		"Plan sizes.",
		"roles: [coordinator]\n",
		"Estimate costs.",
	);
	const input = (
		role: "worker" | "coordinator" | "verifier",
		paths: string[],
	) => principleInputs.render({ role, cwd, paths }, "A brief.").text;
	assert.match(
		input("worker", ["src/money/tick.ts"]),
		/A brief\.[\s\S]+Apply the cent rule/,
	);
	assert.doesNotMatch(
		input("worker", ["src/moneys/tick.ts"]),
		/Apply the cent rule|Estimate costs/,
	);
	assert.match(input("coordinator", []), /Estimate costs/);
	const verify = input("verifier", []);
	assert.match(verify, /money: Review rounding/);
	assert.match(verify, /coordinate: Plan sizes/);
	assert.doesNotMatch(verify, /Apply the cent rule|Estimate costs/);
});
test("a malformed project principle is reported without hiding healthy policy or blocking inputs, and repair takes effect immediately", async (t) => {
	const { cwd, put } = await checkout(t);
	await put("broken", "Read it.", "paths: [bad\n", "Malformed body");
	await put("healthy", "Valid statement.", "roles: [worker]\n", "Good body");
	const index = () => indexFor(cwd, [{ name: "principle" }])!;
	const input = () =>
		principleInputs.render({ cwd, role: "worker" }, "Act.").text;
	assert.match(index(), /unavailable[^\n]*broken/i);
	assert.match(index(), /healthy: Valid statement/);
	assert.match(input(), /unavailable[^\n]*broken/i);
	assert.match(input(), /Good body/);
	assert.doesNotMatch(input(), /Malformed body/);
	await put("broken", "Recovered.", "roles: [worker]\n", "Repaired body");
	assert.doesNotMatch(index(), /unavailable/i);
	assert.match(input(), /Repaired body/);
});
test("worker bindings follow the policy pinned at preparation while the index sees checkout edits", async (t) => {
	const { cwd, put } = await checkout(t);
	await put("ticks", "Later statement.", "roles: [worker]\n", "Later body");
	const projectPrinciples = [
		{
			name: "ticks",
			body: '---\ndescription: "Original statement."\nroles: [worker]\n---\nOriginal body',
		},
	];
	const { text } = principleInputs.render(
		{ cwd, role: "worker", situation: "survived_fix", projectPrinciples },
		"Rework.",
	);
	assert.match(text, /Original body/);
	assert.doesNotMatch(text, /Later body/);
	assert.match(
		indexFor(cwd, [{ name: "principle" }])!,
		/ticks: Later statement/,
	);
});
test("shape binds domain modeling and only a survived fix triggers a worker's premise check", async (t) => {
	const { cwd } = await checkout(t);
	const input = (role: "designer" | "worker", situation: string) =>
		principleInputs.render({ role, cwd, situation }, "task").text;
	assert.match(input("designer", "shape"), /# Model the Domain/);
	assert.doesNotMatch(input("worker", "rework"), /# Attack the Premise/);
	assert.match(input("worker", "survived_fix"), /# Attack the Premise/);
});
const cite = defineLaneTool({
	lane: "toy",
	roles: ["worker"],
	name: "cite",
	description: "Cite a principle",
	gate: "standing",
	terminate: true,
	parameters: obj({ name: str() }),
	citations: ({ name }) => [name],
	event: () => ({ kind: "publish" }),
});
test("rulings admit delivered and pulled bodies, not index-only names, another worker's pulls or an unsent input", async (t) => {
	const { cwd, put } = await checkout(t);
	await put("on-desk", "Worker policy.", "roles: [worker]\n", "Bound body.");
	await put("lookup", "Read by judgement.", "", "Original body.");
	// Replay the first pull on the very same durable task, after its source changed.
	let replayed = false;
	const plainTools = principleTools.map(({ roles, tool }) => ({
		roles,
		tool: {
			...tool,
			async execute(...call: Parameters<typeof tool.execute>) {
				const result = await tool.execute(...call);
				if (replayed) return result;
				replayed = true;
				await put(
					"lookup",
					"Read by judgement.",
					"",
					"This was never delivered.",
				);
				return tool.execute(...call);
			},
		},
	}));
	const x = await toy({ tools: [cite], plainTools, input: principleInputs });
	t.after(() => x.harness.close(ctx));
	await x.harness.commit((tx) => configure(tx, x.root.id, { cwd }), ctx);
	await x.send("agent", { count: 2 });
	await x.send("quiet");
	x.harness.resume();
	await x.finish("keel.deliver");
	const workers = await Promise.all(
		(await x.agents()).map((id) => x.harness.conversation(id, ctx)),
	);
	const call = async (conv: Conversation, tool: string, name: string) => {
		x.provider.setResponses([
			fauxAssistantMessage([fauxToolCall(tool, { name })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await (await conv.submit({ type: "input", content: "Act." }, ctx)).wait(
			ctx,
		);
		const rows = (
			await conv.entries({ order: "descending" }, 30, undefined, ctx)
		).items;
		const result = rows
			.flatMap((e) => e.model ?? [])
			.find((m) => m.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		return { error: result.isError, text: JSON.stringify(result.content) };
	};
	const [a, b] = workers;
	assert.ok(a && b);
	for (const name of ["on-desk", "lookup", "missing"]) {
		const refused = await call(a, "cite", name);
		assert.equal(refused.error, true, name);
		assert.match(refused.text, /pull/i);
	}
	const pull = () => call(a, "principle", "lookup");
	assert.match((await pull()).text, /Original body/);
	await put("lookup", "Read by judgement.", "", "Replacement body.");
	assert.match((await pull()).text, /Replacement body/);
	assert.equal(
		(await a.entries({}, 100, undefined, ctx)).items.filter(
			(e) => e.kind === "keel.pull",
		).length,
		2,
		"one durable pull per call, including under replay",
	);
	assert.equal((await call(b, "cite", "lookup")).error, true);
	assert.equal((await call(a, "cite", "lookup")).error, false);
	x.provider.setResponses([
		fauxAssistantMessage([fauxToolCall("cite", { name: "on-desk" })], {
			stopReason: "toolUse",
		}),
	]);
	const other = await x.harness.createConversation(
		{ ownership: { kind: "ownerless" } },
		ctx,
	);
	await x.deliver("toy", other.id, { kind: "agent" });
	await x.finish("keel.deliver");
	assert.equal(
		(await x.state(other.id)).publications,
		1,
		"bound body admitted its ruling",
	);
});
