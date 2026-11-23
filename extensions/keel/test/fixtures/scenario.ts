import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import type { JsonObject, Storage } from "tau/durable";
import type { FauxResponseStep } from "tau/testing";
import { WorkState } from "../../src/kernel/records.ts";
import { stateDoc } from "../../src/kernel/state.ts";
import type { EffectRunner } from "../../src/kernel/tasks.ts";
import { openScriptedWorkflow } from "./kernel.ts";

export { openScriptedWorkflow } from "./kernel.ts";

const prompt =
	"Fix book according to its approved format: repaired, followed by one newline.";
const rule = "Write repaired and a trailing newline.";
const what = "Preserve the single-line representation.";
const risk = "Only the documented format was exercised.";
const note = "No other readers changed.";
const goal = "Repair the stored book line.";
const summary = "Restored the documented book line.";
const thread = "line-ending";
const evidence = "The checked-out book has no trailing newline.";
type Phase = "rework" | "through-publish" | "through-land" | "after-landing";

export async function openScenario(
	cwd: string,
	storage: Storage,
	phase: Phase,
	runner?: EffectRunner,
	now?: () => number,
) {
	const first = phase === "rework" || phase === "through-publish";
	const rework = phase === "rework";
	const {
		store,
		root,
		provider,
		queueProvider,
		turn,
		settle,
		asks,
		readAsk,
		answer,
	} = await openScriptedWorkflow(cwd, storage, first, runner, now);
	const { harness } = store;
	const script: FauxResponseStep[] = [];
	const call = (...args: Parameters<typeof turn>) => script.push(turn(...args));
	const proof = join(cwd, ".git", "merge-proof");
	if (first) {
		call(
			"designer",
			"ground",
			{
				route: "follow",
				reference: "Owner's approved format",
				mandate: {
					intent: goal,
					nodes: [
						{
							label: "format",
							rule,
							probe: "Compare bytes including the newline.",
						},
					],
					checks: [
						{
							id: "bytes",
							argv: [
								"sh",
								"-c",
								`printf 'repaired\\n' | cmp - book && git rev-parse HEAD > "$1"`,
								"proof",
								proof,
							],
							timeoutMs: 5000,
						},
					],
				},
			},
			prompt,
		);
		call(
			"coordinator",
			"publish_plan",
			{ items: [{ id: "repair", kind: "build", goal, deps: [] }] },
			goal,
		);
		call("coordinator", "brief_item", {
			item: "repair",
			goal,
			evidence: "Compare bytes including newline.",
			fences: "book",
			nodes: ["format"],
		});
		call(
			"worker",
			"bash",
			{
				command: `printf '${rework ? "repaired" : "repaired\\n"}' > book && git commit -am 'repair book'`,
			},
			"Fences: book",
		);
		call("worker", "record_ruling", {
			what,
			why: "The approved format has one line.",
			rank: 1,
			cost: "Readers would split a record.",
			follows: "format",
		});
		call("worker", "publish_build", { summary: "Repair book", addresses: [] });
	}
	const inspect = (command: string) =>
		call("verifier", "bash", {
			command: `! git symbolic-ref -q HEAD && ${command}`,
		});
	if (rework) {
		inspect(`printf 'repaired' | cmp - book`);
		call("verifier", "publish_verdict", {
			outcome: "fail",
			text: evidence,
			blocks: [{ thread, ground: "failing_run", evidence }],
			notes: [],
		});
		call(
			"worker",
			"bash",
			{
				command: `printf 'repaired\\n' > book && git commit -am 'restore newline'`,
			},
			thread,
		);
		call("worker", "publish_build", {
			summary: "Restore the trailing newline",
			addresses: [thread],
		});
	}
	if (rework || phase === "through-land") {
		inspect(`printf 'repaired\\n' | cmp - book`);
		call("verifier", "publish_verdict", {
			outcome: "pass",
			text: "The published bytes match.",
			blocks: [],
			notes: [note],
		});
		call("coordinator", "handoff_build", { summary, risk });
		inspect(
			`test "$(git rev-parse HEAD)" = "$(cat "$(git rev-parse --git-common-dir)/merge-proof")" && printf 'repaired\\n' | cmp - book`,
		);
		call("verifier", "publish_verdict", {
			outcome: "pass",
			text: "The integrated book matches the approved format.",
			blocks: [],
			notes: [],
		});
	}
	provider.setResponses(script);
	if (rework || phase === "through-land") {
		queueProvider.setResponses([
			turn(
				"investigator",
				"report_investigation",
				{
					finding: 1,
					classification: "no_action",
					evidence:
						"The published bytes match; no other reader needs a change.",
					size: "small",
					cause: "book readers",
					recommendation: "no_action",
				},
				note,
				"The published bytes match.",
				"format",
			),
		]);
	}
	async function assertHistory(expected: {
		publishes: number;
		reviews: number;
		landings: number;
	}) {
		const work = await harness.snapshot(stateDoc(WorkState), root.id, ctx);
		assert.ok(work, "the prompt adopted a work");
		const slots = Object.values(work.agents);
		for (const role of ["worker", "coordinator"])
			assert.equal(
				slots.filter((a) => a.role === role).length,
				1,
				`one ${role} conversation`,
			);
		const tools: string[] = [];
		for (const a of slots) {
			const c = await harness.conversation(a.conversation, ctx);
			assert.ok(c);
			const { items } = await c.entries({}, 200, undefined, ctx);
			for (const message of items.flatMap((e) => e.model ?? [])) {
				if (message.role === "toolResult")
					assert.ok(
						!message.isError,
						`${message.toolName}: ${JSON.stringify(message.content)}`,
					);
				if (message.role === "assistant")
					for (const part of message.content)
						if (part.type === "toolCall") tools.push(part.name);
			}
		}
		const tasks = (await harness.commit((tx) => tx.scanTasks({}, 400), ctx))
			.items;
		const ops = tasks
			.filter((t) => t.kind === "keel.effect")
			.map(
				(t) =>
					((t.input as JsonObject).spec as JsonObject).op as
						| JsonObject
						| undefined,
			);
		assert.deepEqual(
			{
				publishes: tools.filter((n) => n === "publish_build").length,
				reviews: tools.filter((n) => n === "publish_verdict").length,
				landings: ops.filter((op) => op?.kind === "land").length,
			},
			expected,
		);
		const checkouts = ops.filter((op) => op?.kind === "checkout");
		assert.equal(
			checkouts.length,
			Math.max(1, expected.reviews),
			"exactly one durable checkout plan per published review",
		);
		if (expected.reviews === 0)
			assert.equal(
				slots.filter((a) => a.role === "verifier").length,
				0,
				"the verifier had not started at the first kill",
			);
		else
			assert.equal(
				slots
					.filter((a) => a.role === "verifier")
					.reduce((n, a) => n + a.used.length, 0),
				expected.reviews,
				"one verifier turn per review",
			);
		return checkouts.map((op) => String(op?.path));
	}
	async function accept(trunk: string) {
		assert.equal(
			provider.getPendingResponseCount(),
			0,
			"all scripted agent turns ran",
		);
		const open = await asks();
		assert.equal(open.length, 1, "only hand-over needs the owner");
		const handOver = open[0]!;
		assert.equal(handOver.lane, "verify");
		const { d, text: rendered } = await readAsk(handOver);
		assert.deepEqual([...d.choices].sort(), ["accept", "reject"]);
		assert.match(rendered, /no action/i);
		assert.match(rendered, /no other reader needs a change/);
		for (const part of [trunk, goal, what, note, risk])
			assert.ok(
				rendered.includes(part),
				`missing ${part} from hand-over: ${rendered}`,
			);
		await answer(d, "accept");
		await settle();
		assert.deepEqual(await asks(), []);
	}
	return {
		root,
		store,
		provider,
		queueProvider,
		turn,
		settle,
		assertHistory,
		accept,
		start: () => root.submit({ type: "input", content: prompt }, ctx),
	};
}
