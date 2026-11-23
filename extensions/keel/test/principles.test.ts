import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { configure, type Conversation } from "tau/durable";
import { obj, str } from "tau/schema";
import { fauxAssistantMessage } from "tau/testing";
import { agentKey, token } from "../src/kernel/ids.ts";
import { defineLane, defineLaneTool } from "../src/kernel/lane.ts";
import { defineState } from "../src/kernel/state.ts";
import { overlapsFence } from "../src/principles/fences.ts";
import {
	indexFor,
	principleInputs,
	principleSections,
	principleTools,
} from "../src/principles/index.ts";
import { toolTurn, toy } from "./toy.ts";

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
test("fences overlap matching paths in either direction but not neighboring or nested lookalikes", () => {
	for (const [fence, pattern, expected] of [
		[".", "src/money/**", true], // whole repository
		["src", "src/money/**", true], // fence covers the pattern
		["src/money/tick.ts", "src/money", true], // pattern covers the fence
		["./src/money/tick.ts", "src/money/**", true], // normalize fence prefix
		["src/money/", "src/money/**", true], // normalize trailing slash
		["src/ledger", "./src/ledger/**", true], // normalize pattern prefix
		["src/moneys", "src/money/**", false],
		["app/src/money", "src/money/**", false],
		["services/payments/risk", "services/*/risk/limit.ts", true],
		["services/payments/risky", "services/*/risk/limit.ts", false],
	] as const)
		assert.equal(
			overlapsFence(fence, pattern),
			expected,
			`${fence} against ${pattern}`,
		);
});
test("CRLF project frontmatter delivers its description, roles, paths and body", async (t) => {
	const { cwd } = await checkout(t);
	await writeFile(
		join(cwd, ".keel/principles/risk.md"),
		[
			"---",
			"description: Review risk.",
			"roles: [coordinator]",
			"paths:",
			'  - "src/risk/**"',
			"---",
			"",
			"Risk policy.",
		].join("\r\n"),
	);
	assert.match(indexFor(cwd, [{ name: "principle" }])!, /risk: Review risk/);
	for (const facts of [
		{ role: "coordinator" },
		{ role: "worker", paths: ["src/risk/main.ts"] },
	] as const) {
		assert.match(
			principleInputs.render({ cwd, ...facts }, "Act.").text,
			/Risk policy/,
		);
	}
});
test("an unknown principle role is reported, even alongside a valid role", async (t) => {
	const { cwd, put } = await checkout(t);
	await put(
		"wrong",
		"Wrong role.",
		"roles: [worker, workre]\n",
		"Unavailable body.",
	);
	const index = indexFor(cwd, [{ name: "principle" }])!;
	assert.match(index, /unavailable[^\n]*wrong[^\n]*unknown[^\n]*workre/i);
	assert.doesNotMatch(index, /^wrong: /m);
	const input = principleInputs.render({ cwd, role: "worker" }, "Act.").text;
	assert.match(input, /unavailable[^\n]*wrong[^\n]*unknown[^\n]*workre/i);
	assert.doesNotMatch(input, /Unavailable body/);
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

const accessState = defineState({
	kind: "keel.principleTest",
	version: 1,
	scope: "conversation",
	initial: () => ({ phase: "entry" }),
});
const start = defineLaneTool({
	lane: "access",
	roles: ["designer"],
	name: "start",
	gate: "adopt",
	description: "Adopt the designer conversation",
	parameters: obj({}),
	terminate: true,
	event: () => ({ kind: "active" }),
});
async function withAccess(cwd: string, t: TestContext) {
	const x = await toy({
		lanes: [
			defineLane(
				{
					name: "access",
					state: accessState,
					asks: () => [],
					effects: () => [],
					view: (s) => s,
					onFact: (state) => ({ state }),
					reduce: (_s, e) => ({ state: { phase: e.kind } }),
					agents: ({ phase }) => {
						if (phase === "workers")
							return ["pinned", "empty"].map((key) => ({
								key: agentKey(key),
								role: "worker" as const,
								cwd,
								paused: false,
								projectPrinciples:
									key === "empty"
										? []
										: [
												{
													name: "ticks",
													body: "---\ndescription: Prepared statement.\nroles: [worker]\n---\nPrepared body.",
												},
											],
								expects:
									key === "empty"
										? []
										: [
												{
													token: token(key, 1),
													tools: [],
													input: () => "Rework.",
												},
											],
							}));
						return phase === "retired" || phase === "entry"
							? []
							: [
									{
										key: agentKey("designer"),
										role: "designer",
										cwd,
										paused: phase === "paused",
										expects: [],
									},
								];
					},
				},
				{ version: 1, sample: accessState.initial },
			),
		],
		tools: [start],
		plainTools: principleTools,
		sections: principleSections,
		input: principleInputs,
	});
	t.after(() => x.harness.close(ctx));
	await x.harness.commit((tx) => configure(tx, x.root.id, { cwd }), ctx);
	return x;
}

test("only the active bound designer sees the principle index and may pull", async (t) => {
	const { cwd, put } = await checkout(t);
	await put("ticks", "Read this statement.", "", "Read this body.");
	const x = await withAccess(cwd, t);
	const before = await x.request(x.root, "start");
	assert.equal(before.result?.isError, false);
	assert.equal(before.sections["keel-principles"] ?? null, null);
	const after = await x.request(x.root, "principle", { name: "ticks" });
	assert.match(
		after.sections["keel-principles"] ?? "",
		/ticks: Read this statement/,
	);
	assert.equal(after.result?.isError, false);
	for (const phase of ["paused", "retired"]) {
		await x.deliver("access", x.root.id, { kind: phase });
		await x.finish("keel.stop");
		const { sections, result } = await x.request(x.root, "principle", {
			name: "ticks",
		});
		assert.equal(result?.isError, true, phase);
		assert.equal(sections["keel-principles"] ?? null, null, phase);
	}
});

test("worker delivery, index and pulls share the prepared snapshot, including an empty snapshot", async (t) => {
	const { cwd, put } = await checkout(t);
	await put(
		"ticks",
		"Checkout statement.",
		"roles: [worker]\n",
		"Checkout body.",
	);
	await put("added", "Added statement.", "", "Added body.");
	const x = await withAccess(cwd, t);
	await x.deliver("access", x.root.id, { kind: "workers" });
	x.provider.setResponses([fauxAssistantMessage("Done")]);
	x.harness.resume();
	await x.finish("keel.deliver");
	const [pinnedId, emptyId] = await x.agents();
	assert.ok(pinnedId && emptyId);
	const pinned = await x.harness.conversation(pinnedId, ctx);
	const empty = await x.harness.conversation(emptyId, ctx);
	const original = await x.request(pinned, "principle", { name: "ticks" });
	const added = await x.request(pinned, "principle", { name: "added" });
	const noProject = await x.request(empty, "principle", { name: "ticks" });
	assert.match(original.prompt, /Prepared body\./);
	assert.match(original.prompt, /ticks: Prepared statement\./);
	assert.match(JSON.stringify(original.result?.content), /Prepared body\./);
	assert.match(noProject.prompt, /attack-the-premise/);
	for (const run of [original, noProject])
		assert.doesNotMatch(
			run.prompt,
			/Checkout statement|Checkout body|Added statement/,
		);
	assert.equal(added.result?.isError, true);
	assert.equal(noProject.result?.isError, true);
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
		const { result } = await x.request(conv, tool, { name });
		assert.ok(result);
		return { error: result.isError, text: JSON.stringify(result.content) };
	};
	const [a, b] = workers;
	assert.ok(a && b);
	for (const name of ["on-desk", "lookup", "missing"]) {
		const refused = await call(a, "cite", name);
		assert.equal(refused.error, true, name);
		assert.match(refused.text, /pull/i);
	}
	const cutoff = (await a.entries({ order: "descending" }, 1, undefined, ctx))
		.items[0]?.id;
	assert.ok(cutoff);
	const pull = () => call(a, "principle", "lookup");
	assert.match((await pull()).text, /Original body/);
	assert.match(
		(await x.harness.commit(
			(tx) => principleInputs.checkCitations(tx, a.id, cutoff, ["lookup"]),
			ctx,
		)) ?? "",
		/Pull the principle first: lookup/,
	);
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
	x.provider.setResponses([toolTurn("cite", { name: "on-desk" })]);
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
