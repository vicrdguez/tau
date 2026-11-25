import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	Codemode,
	CodingTools,
	createRegistry,
	defineExtension,
	defineTool,
	MemoryStorage,
	type ToolRegistration,
} from "tau/durable";
import { obj } from "tau/schema";
import { createModels, openStore } from "tau/testing";
import { explorerDispatch } from "../src/roles/dispatch.ts";
import {
	type KeelOptions,
	options,
	ROLES,
	type RoleName,
	settings,
	storedRole,
} from "../src/roles/index.ts";

const lanes = {
	design: "planning/design",
	build: "building/build",
	verify: "checking/verify",
	queue: "triage/queue",
};
const laneRoles = [
	[
		"design",
		[
			"designer",
			"design_explorer",
			"design_prototype",
			"arena_seat_1",
			"arena_seat_2",
			"arena_seat_3",
			"arena_judge",
			"arena_challenger",
		],
	],
	["build", ["coordinator", "worker", "build_explorer"]],
	["verify", ["verifier", "diagnoser"]],
	["queue", ["investigator", "queue_explorer", "sweeper"]],
] as const satisfies ReadonlyArray<
	readonly [keyof typeof lanes, readonly RoleName[]]
>;

const tool = (name: string) =>
	defineTool({
		name,
		description: name,
		parameters: obj({}),
		execute: async () => ({}),
	});
const publish = tool("publish");
const inspect = tool("inspect");
const specs = [
	{ roles: ["worker"], tool: publish },
	{ roles: ["worker", "verifier"], tool: inspect },
] satisfies { roles: readonly RoleName[]; tool: ToolRegistration }[];
const extension = defineExtension({ name: "keel", tools: [publish, inspect] });

// Failure cases: a role is required instead of its lane; a model inherits from
// the wrong lane or sibling; omitting optional settings breaks an old project.
test("role settings retain lane defaults, independent overrides and tool authority", async (t) => {
	const registry = createRegistry();
	const { harness } = await openStore(
		new MemoryStorage(),
		{ registry, models: createModels() },
		ctx,
	);
	t.after(() => harness.close(ctx));
	const read = (patch: Partial<KeelOptions>) =>
		harness.commit(async (tx) => {
			await options.set(tx, patch);
			return options.read(tx);
		}, ctx);
	await assert.rejects(
		read({ ...lanes, trunk: "main" }),
		/trunk.*base|base.*trunk/i,
	);
	const defaults = await read(lanes);
	const { base, trunk, max_workers, dispatch_rounds, dispatch_minutes } =
		defaults;
	assert.deepEqual(
		{ base, trunk, max_workers, dispatch_rounds, dispatch_minutes },
		{
			base: "main",
			trunk: "trunk",
			max_workers: 3,
			dispatch_rounds: 64,
			dispatch_minutes: 20,
		},
	);
	const bounded = await read({
		...lanes,
		dispatch_rounds: 5,
		dispatch_minutes: 2,
	});
	assert.equal(bounded.dispatch_rounds, 5);
	assert.equal(bounded.dispatch_minutes, 2);
	const overrides = Object.fromEntries(
		laneRoles.flatMap(([, roles]) =>
			roles.map((role) => [role, `custom/${role}`]),
		),
	);
	const chosen = await read({ ...lanes, ...overrides });
	for (const [lane, roles] of laneRoles) {
		const { [lane]: _missing, ...incomplete } = lanes;
		await assert.rejects(
			read({ ...incomplete, ...overrides }),
			`missing ${lane} model`,
		);
		for (const role of roles) {
			const inherited = settings(role, defaults, extension, specs);
			assert.equal(
				`${inherited.model?.provider}/${inherited.model?.modelId}`,
				lanes[lane],
				role,
			);
			assert.deepEqual(
				settings(role, chosen, extension, specs).model,
				{ provider: "custom", modelId: role },
				role,
			);
		}
	}

	const codemodeTools = Codemode.tools ?? [];
	await t.test("every role selects Codemode and all its tools", () => {
		for (const role of Object.keys(ROLES).map(storedRole)) {
			const agent = settings(role, defaults, extension, specs);
			assert.deepEqual(
				agent.extensions,
				[CodingTools, Codemode, extension],
				role,
			);
			assert.ok(Array.isArray(agent.tools), role);
			for (const tool of codemodeTools)
				assert.ok(agent.tools.includes(tool), `${role} lacks ${tool.name}`);
		}
	});

	assert.deepEqual([...explorerDispatch.roles].sort(), [
		"designer",
		"investigator",
		"worker",
	]);
	const worker = {
		role: "worker",
		cwd: null,
		options: chosen,
		view: () => null,
		priorWorks: [],
	} as const;
	const seat = await explorerDispatch.resolve(worker, {
		seat: "build_explorer",
		question: "Check the inputs",
	});
	assert.deepEqual(seat?.model, {
		provider: "custom",
		modelId: "build_explorer",
	});
	assert.deepEqual(seat?.extensions, [CodingTools, Codemode]);
	for (const tool of codemodeTools)
		assert.ok(seat?.tools.includes(tool), `build_explorer lacks ${tool.name}`);
	assert.equal(
		await explorerDispatch.resolve(worker, {
			seat: "design_explorer",
			question: "Check the inputs",
		}),
		undefined,
	);
	for (const [role, expected] of [
		["coordinator", ["read"]],
		["diagnoser", ["bash", "read"]],
		["worker", ["bash", "edit", "inspect", "publish", "read", "write"]],
		["verifier", ["bash", "inspect", "read"]],
		["designer", ["bash", "read"]],
	] as const) {
		const agent = settings(role, defaults, extension, specs);
		assert.match(agent.instructions ?? "", new RegExp(`You are the ${role}`));
		assert.ok(Array.isArray(agent.tools), role);
		assert.deepEqual(
			agent.tools.map((t: ToolRegistration) => t.name).sort(),
			[...expected, ...codemodeTools.map((tool) => tool.name)].sort(),
			role,
		);
	}
});
