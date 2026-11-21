import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, openNodeSqliteStorage } from "tau/durable";
import { fauxAssistantMessage } from "tau/testing";
import { ProjectState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { runRepoEffect } from "../src/workflow.ts";
import { openScriptedWorkflow } from "./fixtures/scenario.ts";
import { fixture, git } from "./repo/fixture.ts";
import { latch } from "./toy.ts";

const started = 1_800_000_000_000;
const minute = 60_000;
const child = fileURLToPath(
	new URL("./fixtures/sweep-kill.ts", import.meta.url),
);
const timer = (kind: string, input: unknown) => {
	const data = input as { spec?: { kind: string }; key?: string };
	return (
		kind.startsWith("keel.effect") &&
		(data.spec?.kind === "sweep" || data.key?.startsWith("sweep/"))
	);
};

async function until<T>(observe: () => Promise<T | undefined>) {
	const end = Date.now() + 8000;
	for (
		let result = await observe();
		Date.now() < end;
		result = await observe()
	) {
		if (result !== undefined) return result;
		await setTimeout(10);
	}
	assert.fail("Workflow did not reach the expected state");
}

test("a durable sweep fires once per tick around SIGKILL, files real playbook drift during a landing, and re-arms while idle", {
	timeout: 35_000,
}, async (t) => {
	const { root } = await fixture(t);
	const file = join(root, ".git", "sweep.sqlite");
	await mkdir(join(root, ".keel", "playbooks"), { recursive: true });
	await writeFile(
		join(root, ".keel", "playbooks", "verify.md"),
		"Run sh old-check.sh.\n",
	);
	git(root, "add", ".keel");
	git(root, "commit", "-m", "Record a drifted verification playbook");
	await assert.rejects(
		promisify(execFile)(
			process.execPath,
			[child, root, file, String(started)],
			{ timeout: 12000 },
		),
		{ signal: "SIGKILL", stdout: "kill:landing\n" },
	);

	const landing = latch();
	const a = await openScriptedWorkflow(
		root,
		await openNodeSqliteStorage(file),
		false,
		async (input, ctx, owner) => {
			if ((input.spec.op as JsonObject | undefined)?.kind === "land")
				await landing.promise;
			return runRepoEffect(input, ctx, owner);
		},
		() => started + minute,
	);
	const { harness } = a.store;
	t.after(() => harness.close(ctx));
	a.sweeper.setResponses([
		a.turn("sweeper", "bash", {
			command:
				"git show trunk:.keel/playbooks/verify.md; ! git cat-file -e trunk:old-check.sh",
		}),
		(context) => {
			assert.match(
				JSON.stringify(context.messages.at(-1)),
				/Run sh old-check\.sh/,
			);
			return fauxAssistantMessage(
				JSON.stringify([
					{
						text: "Verification playbook calls a removed check.",
						report:
							".keel/playbooks/verify.md names old-check.sh; Git has no such file on trunk.",
					},
				]),
			);
		},
	]);
	a.queueProvider.setResponses([
		a.turn("investigator", "report_investigation", {
			finding: 2,
			classification: "defect_in_scope",
			evidence: "The command's script is absent from trunk.",
			size: "small",
			cause: "verification command drift",
			recommendation: "build",
		}),
	]);
	harness.resume();
	try {
		const queue = await until(async () =>
			Object.values(
				(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
			).find((a) => a.lane === "queue"),
		);
		const p = await harness.snapshot(stateDoc(ProjectState), ctx);
		assert.ok(p);
		const ask = await harness.commit((tx) => decision(tx, queue.decision), ctx);
		assert.ok(ask?.status === "open");
		const basis = await harness.commit((tx) => tx.entry(ask.basis), ctx);
		assert.match(
			JSON.stringify(basis?.data),
			/playbook calls a removed check[\s\S]*old-check\.sh/i,
		);
		assert.deepEqual(
			Object.values(p.asks).map((a) => a.local),
			["triage/2"],
		);
		assert.equal(a.sweeper.state.callCount, 2);
	} finally {
		landing.resolve(undefined);
	}
	await a.settle(timer);
	assert.deepEqual(
		Object.values(
			(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
		)
			.map((a) => a.local)
			.sort(),
		["handover", "triage/2"],
	);
	await harness.close(ctx);

	for (const tick of [1, 2]) {
		const b = await openScriptedWorkflow(
			root,
			await openNodeSqliteStorage(file),
			false,
			undefined,
			() => started + tick * minute,
		);
		try {
			b.sweeper.setResponses([fauxAssistantMessage("[]")]);
			b.store.harness.resume();
			await until(async () => {
				const { tasks } = await b.store.harness.inspect(ctx);
				return tasks.find(
					({ record, state }) =>
						timer(record.kind, record.input) &&
						JSON.stringify(state).includes(
							String(started + (tick + 1) * minute),
						),
				);
			});
			assert.equal(
				b.sweeper.state.callCount,
				tick - 1,
				`sweep calls at tick ${tick}`,
			);
			assert.deepEqual(
				Object.values(
					(await b.store.harness.snapshot(stateDoc(ProjectState), ctx))?.asks ??
						{},
				)
					.map((a) => a.local)
					.sort(),
				["handover", "triage/2"],
			);
		} finally {
			await b.store.harness.close(ctx);
		}
	}
});
