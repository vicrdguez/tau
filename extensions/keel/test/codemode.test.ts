import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type Conversation, type JsonObject, MemoryStorage } from "tau/durable";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "tau/testing";
import { WorkState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { buildDoc } from "../src/lanes/build/state.ts";
import { queueLane } from "../src/lanes/queue/index.ts";
import { openScriptedWorkflow } from "./fixtures/kernel.ts";
import { tempRepo } from "./fixtures/repo.ts";

const call = (name: string, args: JsonObject) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function results(conversation: Conversation, name: string) {
	const { items } = await conversation.entries({}, 50, undefined, ctx);
	return items.flatMap(({ model }) =>
		(model ?? [])
			.filter((m) => m.role === "toolResult")
			.filter((m) => m.toolName === name),
	);
}

test("a Keel designer reads a file and classifies its contents in codemode", async (t) => {
	const { root } = await tempRepo(t);
	const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
	t.after(s.close);
	const { provider, getModel } = fauxProvider({
		provider: "fixture-classifier",
	});
	const classifier = {
		...getModel(),
		type: "classifier",
		api: "typesafe-system-one",
	} as const;
	let contents: unknown;
	s.models.setProvider({
		...provider,
		getAllModels: () => [classifier],
		async classify(model, context) {
			contents = context.state.contents;
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				timestamp: 0,
				answers: { old: { type: "bool", probability: 0.875 } },
			};
		},
	});
	s.provider.setResponses([
		call("codemode", {
			code: `
				const contents = await tools.read({ path: "book" });
				const model = await models.getModelOfType("classifier", ${JSON.stringify(classifier.provider)}, ${JSON.stringify(classifier.id)});
				const { answers } = await models.classify(model, {
					state: { contents },
					questions: { old: {
						type: "bool",
						instructions: "Is this the original text?",
						criteria: { true: "Original", false: "Changed" },
					} },
				});
				text("Original probability: " + answers.old.probability);
			`,
		}),
		fauxAssistantMessage("Done."),
	]);
	await s.submit("Classify the book.");
	await s.settle();
	const [result] = await results(s.root, "codemode");
	assert.equal(result?.isError, false, JSON.stringify(result?.content));
	assert.match(
		JSON.stringify(result.content),
		/Original probability: 0\.875\b/,
	);
	assert.equal(contents, "old\n");
});

test("a dispatched Keel explorer reads a file through codemode", async (t) => {
	const { root } = await tempRepo(t);
	const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
	t.after(s.close);
	s.explorer.setResponses([
		call("codemode", {
			code: 'text("Explorer read: " + await tools.read({ path: "book" }));',
		}),
		({ messages }) => {
			const result = messages.at(-1);
			return fauxAssistantMessage(JSON.stringify(result));
		},
	]);
	s.provider.setResponses([
		call("dispatch", {
			jobs: [{ seat: "design_explorer", question: "Read book." }],
		}),
		fauxAssistantMessage("Done."),
	]);
	await s.submit("Ask an explorer to read the book.");
	await s.settle();
	const [result] = await results(s.root, "dispatch");
	assert.equal(result?.isError, false, JSON.stringify(result?.content));
	assert.match(JSON.stringify(result.content), /Explorer read: old\b/);
});

test("Keel codemode preserves role tool restrictions", async (t) => {
	const { root } = await tempRepo(t);
	const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
	t.after(s.close);
	const marker = join(root, "unexpected-bash");
	const goal = "Keep the book on one line.";
	const ruling = {
		what: "Keep one line.",
		why: goal,
		cost: "Unreadable book",
		rank: 1,
		follows: "line",
	};
	const finding = {
		text: "The book contains an extra line.",
		report: "Read book.",
		nodes: ["line"],
	};
	s.provider.setResponses([
		s.turn("designer", "ground", {
			route: "follow",
			reference: "Approved book format",
			mandate: {
				intent: goal,
				nodes: [{ label: "line", rule: goal, probe: "Count lines." }],
				checks: [{ id: "book", argv: ["test", "-f", "book"], timeoutMs: 1000 }],
			},
		}),
		call("codemode", {
			code: `await tools.bash(${JSON.stringify({ command: `touch "${marker}"` })});`,
		}),
		call("publish_plan", {
			items: [{ id: "book", kind: "build", goal, deps: [] }],
		}),
		call("brief_item", {
			item: "book",
			goal,
			evidence: "Count lines.",
			fences: "book",
			nodes: ["line"],
		}),
		call("codemode", {
			code: `await tools.record_ruling(${JSON.stringify(ruling)});`,
		}),
		call("codemode", {
			code: `await tools.file_finding(${JSON.stringify(finding)});`,
		}),
		fauxAssistantMessage("Done."),
	]);
	await s.submit(goal);
	await s.settle();
	const { harness } = s.store;
	const work = await harness.snapshot(stateDoc(WorkState), s.work, ctx);
	assert.ok(work);
	const agents = Object.values(work.agents);
	async function bound(role: string) {
		const agent = agents.find((slot) => slot.role === role);
		assert.ok(agent, role);
		const conversation = await harness.conversation(agent.conversation, ctx);
		assert.ok(conversation);
		return conversation;
	}
	await t.test(
		"a coordinator script cannot call bash or run a command",
		async () => {
			const coordinator = await bound("coordinator");
			const [result] = await results(coordinator, "codemode");
			assert.equal(result?.isError, true);
			assert.match(
				JSON.stringify(result.content),
				/tools\.bash does not exist/,
			);
			await assert.rejects(access(marker), { code: "ENOENT" });
		},
	);
	await t.test(
		"a worker script cannot record rulings or file findings",
		async () => {
			const worker = await bound("worker");
			const agent = await worker.agent(ctx);
			const denied = ["record_ruling", "file_finding"];
			const attempts = await results(worker, "codemode");
			assert.equal(attempts.length, denied.length);
			assert.ok(attempts.every((result) => result.isError));
			const errors = JSON.stringify(attempts.map((result) => result.content));
			for (const name of denied) {
				assert.ok(
					agent.tools.some((tool) => tool.name === name),
					name,
				);
				assert.match(errors, new RegExp(`tools\\.${name} does not exist`));
			}
			const build = await harness.snapshot(stateDoc(buildDoc), s.work, ctx);
			assert.equal(build?.items.length, 1);
			assert.deepEqual(
				build.items.flatMap((item) => item.rulings),
				[],
			);
			const findings = await queueLane.use(async ({ state, view }) => {
				assert.equal(state.scope, "session");
				const snapshot = await harness.snapshot(stateDoc(state), ctx);
				if (!snapshot) return "";
				const queue = view(snapshot) as {
					findingsFor(work: typeof s.work): string;
				};
				return queue.findingsFor(s.work);
			});
			assert.equal(findings, "");
		},
	);
});
