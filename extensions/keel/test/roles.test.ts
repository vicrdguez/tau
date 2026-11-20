import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	CodingTools,
	createRegistry,
	defineExtension,
	defineTool,
	MemoryStorage,
	type ToolRegistration,
} from "tau/durable";
import { obj } from "tau/schema";
import { createModels, openStore } from "tau/testing";
import {
	type KeelOptions,
	options,
	type RoleName,
	settings,
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
	["queue", ["investigator", "queue_explorer"]],
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
test("four lane models suffice; every role and seat can independently override its lane", async (t) => {
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
	assert.equal(defaults.trunk, "trunk");
	assert.equal(defaults.base, "main");
	assert.equal(defaults.max_workers, 3);
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
});

// Failure cases: a project default or another role's tool leaks in; the
// verifier loses bash; a shared registration is available to only one role.
test("configured agents see their coding tools and only their assigned Keel tools", async (t) => {
	const registry = createRegistry();
	const unrelated = defineExtension({
		name: "unrelated",
		tools: [tool("external")],
	});
	for (const ext of [CodingTools, extension, unrelated]) registry.install(ext);
	const { harness } = await openStore(
		new MemoryStorage(),
		{
			registry,
			models: createModels(),
			settings: () => ({ extensions: [CodingTools, unrelated] }),
		},
		ctx,
	);
	t.after(() => harness.close(ctx));
	const opts = await harness.commit(async (tx) => {
		await options.set(tx, lanes);
		return options.read(tx);
	}, ctx);
	for (const [role, expected] of [
		["coordinator", ["read"]],
		["diagnoser", ["bash", "read"]],
		["worker", ["bash", "edit", "inspect", "publish", "read", "write"]],
		["verifier", ["bash", "inspect", "read"]],
		["designer", ["bash", "read"]],
	] as const) {
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: settings(role, opts, extension, specs),
			},
			ctx,
		);
		const agent = await conversation.agent(ctx);
		assert.match(agent.instructions ?? "", new RegExp(`You are the ${role}`));
		if (role === "designer") {
			assert.match(agent.instructions ?? "", /## Proof/);
			assert.match(
				agent.instructions ?? "",
				/reserved[^\n]*`intent`[^\n]*`protectedPaths`/i,
			);
			assert.match(agent.instructions ?? "", /share[^\n]*label/i);
			assert.match(
				agent.instructions ?? "",
				/tell the owner[^\n]*confirmation[^\n]*call `request_cancel`/i,
			);
			assert.doesNotMatch(agent.instructions ?? "", /\{\{form\}\}/);
		}
		assert.deepEqual(agent.tools.map((t) => t.name).sort(), expected, role);
		assert.deepEqual(
			agent.extensions.map((e) => e.name).sort(),
			[CodingTools.name, extension.name].sort(),
			role,
		);
	}
});
