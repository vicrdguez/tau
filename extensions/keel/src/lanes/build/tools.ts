import { arr, int, obj, oneOf, opt, str } from "tau/schema";
import { defineLaneTool } from "../../kernel/lane.ts";
import { nodeExec, readPublishable } from "../../repo/index.ts";
import type { buildView } from "./state.ts";

const text = str({ minLength: 1 });
const texts = arr(text);
const coord = {
	lane: "build",
	roles: ["coordinator"],
	terminate: true,
} as const;
const worker = { lane: "build", roles: ["worker"] } as const;
export const buildTools = [
	defineLaneTool({
		...coord,
		name: "publish_plan",
		description:
			"Add items with goals and dependencies. Reserve briefs for ready items.",
		parameters: obj({
			items: arr(
				obj({
					id: text,
					kind: oneOf(["build", "encode"]),
					goal: text,
					deps: texts,
				}),
			),
			replies: opt(
				arr(
					obj({
						n: int({ minimum: 1 }),
						status: oneOf(["acted_on", "considered", "dismissed"]),
						reason: text,
					}),
				),
			),
		}),
		event: ({ items, replies }) => ({
			kind: "plan",
			items,
			replies: replies ?? [],
		}),
	}),
	defineLaneTool({
		...coord,
		name: "brief_item",
		description: "Brief the item requested by Keel under named Mandate nodes.",
		parameters: obj({
			item: text,
			goal: text,
			evidence: text,
			fences: text,
			nodes: texts,
		}),
		event: (args) => ({ kind: "brief", ...args }),
	}),
	defineLaneTool({
		...coord,
		name: "handoff_build",
		description: "Send the merged build to full-set verification.",
		parameters: obj({ summary: text, risk: text }),
		event: (args) => ({ kind: "handoff", ...args }),
	}),
	defineLaneTool({
		...worker,
		name: "record_ruling",
		description:
			"Record what you decided, why, the cost if wrong and the reference you followed. Rank higher costs with higher integers.",
		parameters: obj({
			what: text,
			why: text,
			cost: text,
			rank: int({ minimum: 0 }),
			follows: text,
		}),
		gate: "standing",
		terminate: false,
		event: (ruling, _, self) => ({ kind: "ruling", agent: self.agent, ruling }),
	}),
	defineLaneTool({
		...worker,
		name: "publish_build",
		description:
			"Publish your clean committed work. Name only threads this build addresses.",
		parameters: obj({ summary: text, addresses: texts }),
		terminate: true,
		observe: async (_, self, _ctx, view) => {
			const build = view("build") as ReturnType<typeof buildView>;
			const { repo, worker, protectedPaths, inheritedTrunk } =
				build.publicationOf(self.agent);
			const f = await readPublishable(
				nodeExec,
				repo,
				worker,
				protectedPaths,
				inheritedTrunk,
			);
			if (f.kind === "dirty") return { ...f, files: [...f.files] };
			if (f.kind === "ok")
				return { ...f, touched: [...f.touched], changes: [...f.changes] };
			return f;
		},
		event: (args, facts, self) => ({
			kind: "publish",
			agent: self.agent,
			...args,
			facts,
		}),
	}),
] as const;
