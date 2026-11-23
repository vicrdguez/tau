import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	createRegistry,
	Harness,
	type JsonObject,
	openNodeSqliteStorage,
} from "tau/durable";
import { createModels } from "tau/testing";
import {
	BindingState,
	ProjectState,
	ReceiptState,
	WorkState,
} from "../src/kernel/records.ts";
import { defineState, stateDoc } from "../src/kernel/state.ts";
import * as project from "./state/keel.project.ts";
import * as work from "./state/keel.work.ts";

test("version-1 kernel records retain their durable identities and safe initial values", () => {
	for (const [def, kind, scope, initial] of [
		[
			ProjectState,
			"keel.project",
			"session",
			{
				anchor: null,
				root: null,
				works: [],
				asks: {},
				ledger: { agents: {}, effects: {} },
			},
		],
		[WorkState, "keel.work", "conversation", { agents: {}, effects: {} }],
		[
			BindingState,
			"keel.binding",
			"conversation",
			{ binding: null, projectPrinciples: null },
		],
		[
			ReceiptState,
			"keel.receipt",
			"task",
			{ reply: null, terminate: false, isError: false },
		],
	] as const) {
		assert.equal(def.kind, kind);
		assert.equal(def.scope, scope, kind);
		assert.equal(def.version, 1, kind);
		assert.deepEqual(def.initial(), initial, kind);
		assert.ok(!("doc" in def), "lanes must not receive a document token");
	}
});

test("work documents keep only the latest version and forks start unbound", () => {
	for (const doc of [stateDoc(WorkState), stateDoc(BindingState)]) {
		assert.equal(doc.definition.history, "latest");
		assert.equal(doc.definition.fork, "initial");
	}
	assert.equal(stateDoc(ReceiptState).definition.scope, "task");
});

test("a state upgrade cannot be defined without a migration", () => {
	assert.throws(
		() =>
			Reflect.apply(defineState, undefined, [
				{
					kind: "keel.upgrade",
					version: 2,
					scope: "session",
					initial: () => ({ pending: [] }),
				},
			]),
		/migrat/i,
	);
});

test("reopening and upgrading committed v1 records retains their outstanding work", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "keel-state-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "state.sqlite");
	const open = async () => {
		const h = await Harness.open(
			await openNodeSqliteStorage(file),
			{
				registry: createRegistry(),
				models: createModels(),
			},
			ctx,
		);
		t.after(() => h.close(ctx));
		return h;
	};
	const first = await open();
	const { id } = await first.root(ctx);
	await first.commit(async (tx) => {
		Object.assign(await tx.doc(stateDoc(ProjectState)), project.current);
		Object.assign(await tx.doc(stateDoc(WorkState), id), work.current);
	}, ctx);
	await first.close(ctx);

	const reopened = await open();
	assert.deepEqual(
		await reopened.snapshot(stateDoc(ProjectState), ctx),
		project.current,
	);
	const upgraded = stateDoc(
		defineState({
			kind: "keel.work",
			scope: "conversation",
			version: 2,
			initial: (): { ledger: JsonObject; revision: number } => ({
				ledger: { agents: {}, effects: {} },
				revision: 0,
			}),
			migrate(value, fromVersion) {
				assert.equal(fromVersion, 1);
				assert.deepEqual(value, work.current);
				return { ledger: value, revision: 1 };
			},
		}),
	);
	await reopened.commit(async (tx) => {
		(await tx.doc(upgraded, id)).revision++;
	}, ctx);
	assert.deepEqual(await reopened.snapshot(upgraded, id, ctx), {
		ledger: work.current,
		revision: 2,
	});
	await assert.rejects(
		reopened.snapshot(stateDoc(WorkState), id, ctx),
		/version/i,
	);
});

test("state writes checkpoint at the 64th delta, not before", () => {
	const value = { runs: 1 };
	const checkpoint = stateDoc(
		defineState({
			kind: "keel.checkpoints",
			scope: "session",
			version: 1,
			initial: () => value,
		}),
	).definition.checkpointWhen;
	for (const [deltasSinceBase, expected] of [
		[0, false],
		[62, false],
		[63, true],
		[64, true],
	] as const)
		assert.equal(checkpoint(value, [], { deltasSinceBase }), expected);
});
