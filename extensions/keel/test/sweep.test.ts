import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, openNodeSqliteStorage } from "tau/durable";
import { fauxAssistantMessage } from "tau/testing";
import { ProjectState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { replyJson } from "../src/reply-json.ts";
import { runRepoEffect } from "../src/workflow.ts";
import { openScriptedWorkflow } from "./fixtures/kernel.ts";
import { git, tempRepo } from "./fixtures/repo.ts";
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
		(data.spec?.kind === "sweep" || data.key?.startsWith("sweep/") === true)
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

test("JSON replies recover fenced and inline arrays, but not invalid text", () => {
	const findings = [{ text: "Missing proof.", report: "Test at [sha-1]." }];
	const json = JSON.stringify(findings);
	assert.deepEqual(
		replyJson(`Draft: []\n\n\`\`\`json\n${json}\n\`\`\`\n`),
		findings,
	);
	for (const prefix of ["[old notes", "[invalid candidate]"])
		assert.deepEqual(
			replyJson(`${prefix}. Actual result: ${json} Done.`),
			findings,
		);
	assert.equal(replyJson("[no valid findings]"), null);
});

test("a durable sweep fires once per tick around SIGKILL, files real playbook drift during a landing, and re-arms while idle", {
	timeout: 35_000,
}, async (t) => {
	const { root } = await tempRepo(t);
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
	t.after(a.close);
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
				"Found drift: " +
					JSON.stringify([
						{
							text: "Verification playbook calls a removed check.",
							report: `.keel/playbooks/verify.md names old-check.sh; Git has no such file at ${git(root, "rev-parse", "trunk")}.`,
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
	const finding = await (async () => {
		try {
			const queue = await until(async () =>
				(await a.asks()).find((a) => a.lane === "queue"),
			);
			const { d, text } = await a.readAsk(queue);
			assert.deepEqual(
				(await a.asks()).map((a) => a.local),
				["triage/2"],
			);
			assert.match(text, /playbook calls a removed check[\s\S]*old-check\.sh/i);
			assert.ok(
				text.includes(git(root, "rev-parse", "trunk")),
				"finding cites the pinned revision",
			);
			assert.doesNotMatch(text, /Revision: not available/);
			assert.equal(a.sweeper.state.callCount, 2);
			return d;
		} finally {
			landing.resolve(undefined);
		}
	})();
	await a.settle(timer);
	assert.deepEqual((await a.asks()).map((a) => a.local).sort(), [
		"handover",
		"triage/2",
	]);
	await a.answer(finding, "defer");
	await a.settle(timer);
	const settled = await harness.snapshot(stateDoc(ProjectState), ctx);
	assert.equal(
		Object.values(settled!.ledger.effects).length,
		1,
		"only the next timer needs a receipt",
	);
	await a.close();

	// Reopen at the same instant (no repeat), then at the next due tick.
	for (const tick of [1, 2]) {
		const b = await openScriptedWorkflow(
			root,
			await openNodeSqliteStorage(file),
			false,
			undefined,
			() => started + tick * minute,
		);
		try {
			b.sweeper.setResponses([
				(context) => {
					const prompt = JSON.stringify(context);
					assert.match(
						prompt,
						/Verification playbook calls a removed check[\s\S]*deferred/,
					);
					assert.match(
						prompt,
						/dropped or deferred unless the evidence changed/,
					);
					assert.match(prompt, /90% of at least ten/);
					assert.match(prompt, /no citations across at least twenty/);
					assert.match(
						prompt,
						/"worker.*worker\/repair/,
						"collect live sample from the landed build",
					);
					assert.doesNotMatch(
						prompt,
						/"goal.*Repair the stored book line/,
						"a follow seed's unreviewed Mandate is not authority",
					);
					return fauxAssistantMessage("[]");
				},
			]);
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
				(await b.asks()).map((a) => a.local),
				["handover"],
			);
			if (tick === 2) {
				const { harness } = b.store;
				await harness.commit(async (tx) => {
					const { sweep_minutes: _, ...rest } = await b.options.get(tx);
					await b.options.set(tx, rest);
				}, ctx);
				await until(async () =>
					(await harness.inspect(ctx)).tasks.some(({ record }) =>
						timer(record.kind, record.input),
					)
						? undefined
						: true,
				);
				assert.deepEqual(
					(await harness.snapshot(stateDoc(ProjectState), ctx))?.ledger.effects,
					{},
				);
			}
		} finally {
			await b.close();
		}
	}
});
