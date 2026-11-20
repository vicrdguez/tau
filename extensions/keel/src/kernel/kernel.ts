import type { Context } from "tau/chord";
import {
	type AgentChange,
	defineExtension,
	type Extension,
	type JsonObject,
	type Tx,
} from "tau/durable";
import { options, type RoleName, settings } from "../roles/index.ts";
import type { Delivery, RegisteredLane, Result } from "./lane.ts";
import { reconcile } from "./reconcile.ts";
import * as records from "./records.ts";
import { route } from "./routing.ts";
import { project } from "./storage.ts";
import { type EffectInput, makeTasks } from "./tasks.ts";
import { type LaneTool, wrapTool } from "./tool.ts";

export function createKernel(config: {
	lanes: readonly RegisteredLane[];
	tools: readonly LaneTool[];
	/** Recovery may invoke this again with the same key. External operations must converge. */
	runEffect(input: EffectInput, context: Context): Promise<JsonObject>;
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
	const tools = config.tools.map((tool) => wrapTool(tool, transact, scope));
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
	});

	async function transact(
		tx: Tx,
		delivery: Delivery,
		now: number,
	): Promise<Result> {
		const opts = Object.freeze(await options.read(tx));
		const result = await route(tx, lanes, delivery, now, opts);
		if ("reject" in result) return result;
		const p = await project(tx);
		for (const frame of result.frames) {
			frame.save();
			if (frame.work !== null && !p.works.includes(frame.work))
				p.works.push(frame.work);
		}
		const forRole = (role: RoleName) => settings(role, opts, extension, tools);
		for (const frame of result.frames)
			await reconcile(tx, frame, tasks, forRole, now);
		return { reply: result.reply };
	}
	return {
		extension,
		tasks,
		transact,
		entry: (tx: Tx) => roleSettings(tx, "designer"),
	};
}
