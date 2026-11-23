import {
	type AgentChange,
	AgentDoc,
	defineExtension,
	type Extension,
	type ToolRegistration,
	type Tx,
} from "tau/durable";
import {
	type DispatchJob,
	type DispatchRoster,
	dispatchTool,
} from "../dispatch/index.ts";
import {
	dispatchBounds,
	options,
	type RoleName,
	settings,
	storedRole,
} from "../roles/index.ts";
import type { WorkId } from "./ids.ts";
import type {
	Delivery,
	FactDelivery,
	RegisteredLane,
	Result,
	StaticFacts,
} from "./lane.ts";
import { type RenderInput, reconcile } from "./reconcile.ts";
import * as records from "./records.ts";
import { readViews, route } from "./routing.ts";
import { stateDoc } from "./state.ts";
import { project } from "./storage.ts";
import { type EffectRunner, makeTasks } from "./tasks.ts";
import {
	type CheckCitations,
	dispatchCaller,
	type LaneTool,
	wrapPlainTool,
	wrapTool,
} from "./tool.ts";

export function createKernel(config: {
	lanes: readonly RegisteredLane[];
	tools: readonly LaneTool[];
	input?: { render: RenderInput; checkCitations: CheckCitations };
	plainTools?: readonly {
		roles: readonly RoleName[];
		tool: ToolRegistration;
	}[];
	dispatch?: {
		roles: readonly RoleName[];
		/** Conversation lane views that an explorer may read for other project works. */
		history?: readonly string[];
		resolve(
			facts: {
				role: RoleName;
				cwd: string | null;
				options: StaticFacts["options"];
				view: Awaited<ReturnType<typeof readViews>>;
				priorWorks: readonly {
					work: WorkId;
					view: Awaited<ReturnType<typeof readViews>>;
				}[];
			},
			job: DispatchJob,
		): ReturnType<DispatchRoster["resolve"]>;
	};
	sections?: readonly {
		roles: readonly RoleName[];
		section: NonNullable<Extension["sections"]>[number];
	}[];
	/** Recovery may invoke this again with the same key. External operations must converge. */
	runEffect: EffectRunner;
}) {
	const lanes = new Map(config.lanes.map((lane) => [lane.name, lane]));
	if (lanes.size !== config.lanes.length)
		throw new Error("Duplicate Keel lane name");
	// Document kinds, not reducer names, determine storage identity.
	const kinds = new Set<string>([
		"keel.options",
		...Object.values(records).map((record) => record.kind),
	]);
	for (const lane of lanes.values()) {
		const kind = lane.use((l) => l.state.kind);
		if (kinds.has(kind))
			throw new Error(`Keel state kind already has a writer: ${kind}`);
		kinds.add(kind);
	}
	function scope(name: string) {
		const lane = lanes.get(name);
		if (!lane) throw new Error(`Unknown Keel lane: ${name}`);
		return lane.scope;
	}
	const tools = [
		...config.tools.map((tool) =>
			wrapTool(
				tool,
				transact,
				(tx, self) => readViews(tx, lanes, self.work),
				scope,
				config.input?.checkCitations,
			),
		),
		...(config.plainTools ?? []).map(wrapPlainTool),
	];
	const dispatch = config.dispatch;
	if (dispatch) {
		const history = new Map(
			[...lanes].filter(
				([name, lane]) =>
					lane.scope === "conversation" && dispatch.history?.includes(name),
			),
		);
		tools.push({
			roles: dispatch.roles,
			tool: dispatchTool(async (tx, caller) => {
				const { self, bound } = await dispatchCaller(
					tx,
					caller,
					dispatch.roles,
				);
				const opts = await options.read(tx);
				async function readRecord() {
					const work = bound ? self.work : null;
					const view = await readViews(tx, lanes, work);
					const priorWorks = history.size
						? await Promise.all(
								(await project(tx)).works
									.filter((id) => id !== work)
									.map(async (id) => ({
										work: id,
										view: await readViews(tx, history, id),
									})),
							)
						: [];
					return {
						role: self.role,
						cwd: self.cwd,
						options: opts,
						view,
						priorWorks,
					};
				}
				let record: ReturnType<typeof readRecord> | undefined;
				return {
					...dispatchBounds(opts),
					resolve: async (_tx, _caller, job) => {
						record ??= readRecord();
						return dispatch.resolve(await record, job);
					},
				};
			}),
		});
	}
	const adopting = new Set(
		config.tools.filter((t) => t.gate === "adopt").map((t) => t.name),
	);
	async function roleSettings(tx: Tx, role: RoleName): Promise<AgentChange> {
		return settings(role, await options.read(tx), extension, tools);
	}
	const tasks = makeTasks({
		transact,
		roleSettings,
		runEffect: config.runEffect,
	});
	const extension: Extension = defineExtension({
		name: "keel",
		tasks: Object.values(tasks),
		tools: tools.map((t) => t.tool),
		sections:
			config.sections?.map(({ roles, section }) => ({
				...section,
				async render(input, ctx) {
					const binding = (
						await input.read.snapshot(
							stateDoc(records.BindingState),
							input.conversationId,
							ctx,
						)
					)?.binding;
					const role = binding
						? storedRole(binding.role)
						: input.agent.tools.some((t) => adopting.has(t.name))
							? "designer"
							: undefined;
					return role && roles.includes(role)
						? section.render(input, ctx)
						: undefined;
				},
			})) ?? [],
	});

	async function transact(
		tx: Tx,
		delivery: Delivery | FactDelivery,
		now: number,
		caller: WorkId | null = delivery.work,
	): Promise<Result> {
		const opts = Object.freeze(await options.read(tx));
		const p = await project(tx);
		// Tau configures the entry conversation with the project cwd before its first input.
		if (p.root === null && delivery.work !== null)
			p.root = (await tx.doc(AgentDoc, delivery.work)).cwd ?? null;
		if (!p.root)
			throw new Error("No project working directory on the entry conversation");
		const result = await route(tx, lanes, delivery, now, opts, p.root, caller);
		if ("reject" in result) return result;
		for (const frame of result.frames) {
			frame.save();
			if (frame.work !== null && !p.works.includes(frame.work))
				p.works.push(frame.work);
		}
		const forRole = (role: RoleName) => settings(role, opts, extension, tools);
		for (const frame of result.frames)
			await reconcile(tx, frame, tasks, forRole, now, config.input?.render);
		return { reply: result.reply, measures: result.measures };
	}
	return {
		extension,
		tasks,
		transact,
		entry: (tx: Tx) => roleSettings(tx, "designer"),
	};
}
