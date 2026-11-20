import { modelRef, options as projectOptions, prose } from "tau";
import {
	type AgentChange,
	CodingTools,
	type Extension,
	type ToolRegistration,
	type Tx,
} from "tau/durable";
import { int, obj, opt, str } from "tau/schema";

function coding(name: string): ToolRegistration {
	const tool = CodingTools.tools?.find((tool) => tool.name === name);
	if (!tool) throw new Error(`Missing coding tool: ${name}`);
	return tool;
}
const read = [coding("read")];
const inspect = [...read, coding("bash")];
const change = [...inspect, coding("edit"), coding("write")];

const dir = import.meta.dirname;
const form = prose(dir, "../prose/documents/mandate.md", [])({});

export const ROLES = {
	designer: {
		lane: "design",
		tools: inspect,
		instructions: prose(dir, "../prose/roles/designer.md", ["form"])({ form }),
	},
	design_explorer: { lane: "design", tools: inspect },
	design_prototype: { lane: "design", tools: change },
	arena_seat_1: { lane: "design", tools: inspect },
	arena_seat_2: { lane: "design", tools: inspect },
	arena_seat_3: { lane: "design", tools: inspect },
	arena_judge: { lane: "design", tools: read },
	arena_challenger: { lane: "design", tools: inspect },
	coordinator: {
		lane: "build",
		tools: read,
		instructions: prose(dir, "../prose/roles/coordinator.md", [])({}),
	},
	worker: {
		lane: "build",
		tools: change,
		instructions: prose(dir, "../prose/roles/worker.md", [])({}),
	},
	build_explorer: { lane: "build", tools: inspect },
	verifier: {
		lane: "verify",
		tools: inspect,
		instructions: prose(dir, "../prose/roles/verifier.md", [])({}),
	},
	diagnoser: {
		lane: "verify",
		tools: inspect,
		instructions: prose(dir, "../prose/roles/diagnoser.md", [])({}),
	},
	investigator: { lane: "queue", tools: inspect },
	queue_explorer: { lane: "queue", tools: inspect },
} as const;
export type RoleName = keyof typeof ROLES;

export function storedRole(name: string): RoleName {
	if (!Object.hasOwn(ROLES, name))
		throw new Error(`Unknown stored Keel role: ${name}`);
	return name as RoleName;
}

const model = str({ format: "model" });
const override = opt(model);
// Object.fromEntries widens keys to string; these keys are exactly the role names.
const overrides = Object.fromEntries(
	Object.keys(ROLES).map((role) => [role, override]),
) as Record<RoleName, typeof override>;
const defaultTrunk = "trunk";
const defaultBase = "main";
const stored = projectOptions(
	"keel",
	obj({
		design: model,
		build: model,
		verify: model,
		queue: model,
		...overrides,
		trunk: str({ minLength: 1, default: defaultTrunk }),
		base: str({ minLength: 1, default: defaultBase }),
		max_workers: int({ minimum: 1, default: 3 }),
	}),
);
export type KeelOptions = Awaited<ReturnType<typeof stored.read>>;
function distinctBranches(value: Partial<KeelOptions>) {
	if ((value.trunk ?? defaultTrunk) === (value.base ?? defaultBase))
		throw new Error("Keel trunk and base must be different branches");
}
export const options = {
	...stored,
	async set(tx: Tx, value: Partial<KeelOptions>) {
		distinctBranches(value);
		await stored.set(tx, value);
	},
	async read(tx: Tx): Promise<KeelOptions> {
		const value = await stored.read(tx);
		distinctBranches(value);
		return value;
	},
};

export function settings(
	role: RoleName,
	opts: KeelOptions,
	extension: Extension,
	toolSpecs: readonly {
		readonly roles: readonly RoleName[];
		readonly tool: ToolRegistration;
	}[],
): AgentChange {
	const entry = ROLES[role];
	return {
		...("instructions" in entry && { instructions: entry.instructions }),
		model: modelRef(opts[role] ?? opts[entry.lane]),
		extensions: [CodingTools, extension],
		tools: [
			...entry.tools,
			...toolSpecs
				.filter((spec) => spec.roles.includes(role))
				.map((spec) => spec.tool),
		],
	};
}
