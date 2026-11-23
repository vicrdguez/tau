import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { fauxAssistantMessage } from "tau/testing";
import { toy } from "./toy.ts";

const seat = {
	model: { provider: "faux", modelId: "faux-1" },
	extensions: [],
	tools: [],
	instructions: "Answer the question.",
};
const job = { seat: "explorer", question: "What exists?" };

for (const move of ["pause", "cancel"] as const) {
	test(`an agent after ${move} cannot dispatch even if Tau runs its old tool list`, {
		timeout: 3000,
	}, async (t) => {
		const x = await toy({
			dispatch: { roles: ["worker"], resolve: () => seat },
		});
		t.after(() => x.harness.close(ctx));
		await x.send("manual");
		const [id] = await x.agents();
		assert.ok(id);
		await x.send(move);
		x.harness.resume();
		await x.finish("keel.stop");
		const worker = await x.harness.conversation(id, ctx);
		assert.ok(worker);
		const { result } = await x.request(worker, "dispatch", { jobs: [job] });
		const tool = (await x.tasks("pi.tool")).find(
			(t) => t.conversationId === id,
		);
		assert.ok(tool);
		assert.ok(result?.isError);
		assert.match(JSON.stringify(result.content), /not the active bound agent/);
		assert.deepEqual(
			(
				await x.harness.commit(
					(tx) => tx.scanConversations({ ownerTaskId: tool.id }, 10),
					ctx,
				)
			).items,
			[],
		);
	});
}

test("an effect runner reuses its joined child on retry and cannot complete the task itself", {
	timeout: 3000,
}, async (t) => {
	let attempts = 0;
	const x = await toy({
		async runEffect(_input, context, owner) {
			assert.ok(!("commit" in owner));
			const result = await owner.dispatch(
				{ resolve: () => seat },
				[job],
				context,
			);
			if (++attempts === 1)
				throw new Error("interrupted before publishing the effect result");
			return { value: result[0]?.answer ?? "unanswered" };
		},
	});
	t.after(() => x.harness.close(ctx));
	await x.send("effect");
	x.provider.setResponses([fauxAssistantMessage("a joined answer")]);
	x.harness.resume();
	await x.finish("keel.effect");
	assert.deepEqual((await x.state()).facts, ["a joined answer"]);
	assert.equal(attempts, 2);
	assert.equal(x.provider.state.callCount, 1);
	const [effect] = await x.tasks("keel.effect");
	assert.ok(effect);
	assert.equal(
		(
			await x.harness.commit(
				(tx) => tx.scanConversations({ ownerTaskId: effect.id }, 10),
				ctx,
			)
		).items.length,
		1,
	);
});
