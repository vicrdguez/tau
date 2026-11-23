import { arr, obj, oneOf, opt, str } from "tau/schema";
import { defineLaneTool } from "../../kernel/lane.ts";
export const grounds = [
	"failing_run",
	"mandate_violation",
	"weakened_check",
	"false_claim",
	"unprobed_rule",
	"reachable_harm",
] as const;
const words = str({ minLength: 1 });
export const verifyTools = [
	defineLaneTool({
		lane: "verify",
		roles: ["verifier"],
		name: "publish_verdict",
		description: "Record the verdict and its evidence on this checkout.",
		parameters: obj({
			outcome: oneOf(["pass", "fail"]),
			text: words,
			blocks: arr(
				obj({ thread: words, ground: oneOf(grounds), evidence: words }),
			),
			notes: arr(words),
			principlesUnfollowed: opt(arr(obj({ name: words, thread: words }))),
		}),
		terminate: true,
		citations: ({ principlesUnfollowed }) =>
			principlesUnfollowed?.map((p) => p.name) ?? [],
		event: (args, _, self) => ({ kind: "verdict", agent: self.agent, ...args }),
	}),
	defineLaneTool({
		lane: "verify",
		roles: ["diagnoser"],
		name: "publish_diagnosis",
		description: "Record the shared premise, the test and its result.",
		parameters: obj({ premise: words, test: words, result: words }),
		terminate: true,
		event: (args, _, self) => ({
			kind: "diagnosis",
			agent: self.agent,
			...args,
		}),
	}),
];
