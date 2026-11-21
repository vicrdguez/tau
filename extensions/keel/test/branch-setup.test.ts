import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, MemoryStorage } from "tau/durable";
import { fauxAnswer } from "tau/testing";
import { ProjectState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { options } from "../src/roles/index.ts";
import { openScenario } from "./fixtures/scenario.ts";
import { fixture, git } from "./repo/fixture.ts";

async function start(t: TestContext, root: string) {
	const s = await openScenario(root, new MemoryStorage(), "rework");
	const { harness } = s.store;
	t.after(() => harness.close(ctx));
	const patch = (branches: { base?: string; trunk?: string }) =>
		harness.commit(async (tx) => {
			await options.set(tx, { ...(await options.get(tx)), ...branches });
		}, ctx);
	async function hold() {
		const asks = Object.values(
			(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
		);
		assert.equal(asks.length, 1);
		return harness.commit(async (tx) => {
			const d = await decision(tx, asks[0]!.decision);
			assert.ok(d?.status === "open");
			assert.deepEqual(d.choices, ["resume", "cancel"]);
			const entry = await tx.entry(d.basis);
			return { d, text: String((entry?.data as JsonObject).text) };
		}, ctx);
	}
	return { ...s, patch, hold };
}

for (const [option, value, reason] of [
	["base", "bad name", /bad name/],
	["trunk", "bad name", /bad name/],
	["base", "refs/heads/main", /refs\/heads\/main/],
	["trunk", "mAiN", /mAiN/],
	["trunk", "keel/other", /keel\/other/],
	["base", "missing", /missing.*does not exist|does not exist.*missing/],
] as const) {
	test(`build setup names the ${option} option for unusable branch ${value}`, async (t) => {
		const { root } = await fixture(t);
		git(root, "branch", "stable");
		const s = await start(t, root);
		await s.patch({ base: "stable", [option]: value });
		await s.start();
		await s.settle();
		assert.equal(git(root, "for-each-ref", "refs/heads/keel/"), "");
		const { text } = await s.hold();
		assert.ok(text.includes(`\`${option}\` option`), text);
		assert.match(text, reason);
	});
}

test("build setup holds a divergent trunk before making refs; changing trunk to a descendant allows resume", async (t) => {
	const { root, base } = await fixture(t);
	git(root, "switch", "-c", "stray");
	git(root, "commit", "--allow-empty", "-m", "stray work");
	const stray = git(root, "rev-parse", "stray");
	git(root, "switch", "-c", "stable", base);
	git(root, "commit", "--allow-empty", "-m", "owner work");
	git(root, "switch", "-c", "release");
	git(root, "commit", "--allow-empty", "-m", "verified work");
	const release = git(root, "rev-parse", "release");
	git(root, "switch", "main");

	const s = await start(t, root);
	await s.patch({ base: "stable", trunk: "stray" });
	await s.start();
	await s.settle();
	assert.equal(git(root, "for-each-ref", "refs/heads/keel/"), "");
	const { d, text } = await s.hold();
	assert.match(
		text,
		/`trunk` option.*stray.*does not descend from.*`base` option.*stable/,
	);

	await s.patch({ trunk: "release" });
	const answer = await fauxAnswer(s.store, d.id, {
		basis: d.basis,
		choice: "resume",
		annotations: [],
	});
	assert.equal(answer.kind, "answered");
	await s.settle();
	const landed = git(root, "rev-parse", "release");
	assert.notEqual(landed, release);
	assert.equal(git(root, "log", "-1", "--format=%P", "release"), release);
	assert.equal(git(root, "rev-parse", "stray"), stray);
	await s.accept(landed);
});
