import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
	Model,
	ModelCatalog,
	Provider,
	SimpleStreamOptions,
	TranscriptContext,
} from "tau";
import { type RunDeps, run } from "./run.ts";

function thinking(
	model: Model<string>,
	level: SimpleStreamOptions["reasoning"],
): Pick<Options, "effort" | "thinking"> {
	if (!model.reasoning || (!level && model.thinkingLevelMap?.off !== null))
		return { thinking: { type: "disabled" } };
	const mapped = level ? (model.thinkingLevelMap?.[level] ?? level) : "low";
	const effort =
		mapped === "minimal"
			? "low"
			: mapped === "xhigh" && !model.thinkingLevelMap?.xhigh
				? "max"
				: mapped;
	return {
		thinking: { type: "adaptive", display: "summarized" },
		...(effort === "low" ||
		effort === "medium" ||
		effort === "high" ||
		effort === "xhigh" ||
		effort === "max"
			? { effort }
			: {}),
	};
}
export function claudeCode({
	catalog,
	...deps
}: RunDeps & { catalog: ModelCatalog }): Provider<"claude-code"> {
	const stream = (
		model: Model<string>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) =>
		run(
			deps,
			model,
			context,
			options ?? {},
			thinking(model, options?.reasoning),
		);
	return {
		id: "claude-code",
		name: "Claude Code",
		auth: {
			apiKey: {
				name: "Claude Code login",
				resolve: async () => ({ auth: {}, source: "Claude Code login" }),
			},
		},
		getModels: () =>
			catalog
				.getModels("anthropic")
				.filter((m) => !/-\d{8}$/.test(m.id))
				.map(({ compat: _compat, ...m }) => ({
					...m,
					provider: "claude-code",
					api: "claude-code",
					baseUrl: "",
					contextWindow: Math.min(200000, m.contextWindow),
					cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
				})),
		stream,
		streamSimple: stream,
	};
}
