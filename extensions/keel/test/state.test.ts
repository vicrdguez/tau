import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import {
	type ConversationId,
	createRegistry,
	Harness,
	type JsonObject,
	MemoryStorage,
	type Tx,
} from "tau/durable";
import { createModels } from "tau/testing";
import * as records from "../src/kernel/records.ts";
import { defineState, type StateDef, stateDoc } from "../src/kernel/state.ts";
import * as project from "./state/keel.project.ts";
import * as work from "./state/keel.work.ts";

// The per-kind fixtures pin the complete stored types. Keep old versions for migration tests.
const fixtures = {
	ProjectState: {
		def: records.ProjectState,
		kind: "keel.project",
		scope: "session",
		initial: {
			anchor: null,
			root: null,
			works: [],
			asks: {},
			ledger: { agents: {}, effects: {} },
		},
	},
	WorkState: {
		def: records.WorkState,
		kind: "keel.work",
		scope: "conversation",
		initial: { agents: {}, effects: {} },
	},
	BindingState: {
		def: records.BindingState,
		kind: "keel.binding",
		scope: "conversation",
		initial: { binding: null, projectPrinciples: null },
	},
	ReceiptState: {
		def: records.ReceiptState,
		kind: "keel.receipt",
		scope: "task",
		initial: { reply: null, terminate: false, isError: false },
	},
} satisfies Record<keyof typeof records, unknown>;

for (const fixture of Object.values(fixtures)) {
	const { def } = fixture;
	test(`${fixture.kind} keeps its version-1 identity and initial state`, () => {
		assert.equal(def.kind, fixture.kind);
		assert.equal(def.scope, fixture.scope);
		assert.equal(def.version, 1);
		assert.deepEqual(def.initial(), fixture.initial);
		assert.ok(!("doc" in def), "lanes must not receive a document token");
	});
}

test("work documents keep only the latest version and forks start unbound", () => {
	for (const doc of [
		stateDoc(records.WorkState),
		stateDoc(records.BindingState),
	]) {
		assert.equal(doc.definition.history, "latest");
		assert.equal(doc.definition.fork, "initial");
	}
	assert.equal(stateDoc(records.ReceiptState).definition.scope, "task");
});

// Compile-time regression: absence must be explicit even in nested stored values.
// @ts-expect-error optional stored properties would let an unversioned change compile
defineState({
	kind: "keel.optional",
	version: 1,
	scope: "session",
	initial: (): { items: { hold?: string }[] } => ({ items: [] }),
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

// A lane does not carry a Tau token. Narrow its scope before acquiring the token so
// tx.doc takes exactly the address required by the scope.
async function seed<S extends JsonObject>(
	tx: Tx,
	def: Extract<StateDef<S>, { scope: "session" | "conversation" }>,
	id: ConversationId,
	stored: S,
) {
	const doc =
		def.scope === "session"
			? await tx.doc(stateDoc(def))
			: await tx.doc(stateDoc(def), id);
	Object.assign(doc, stored);
}

test("an upgrade reads the old committed value and retains outstanding work", async (t) => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ registry: createRegistry(), models: createModels() },
		ctx,
	);
	t.after(() => harness.close(ctx));
	const root = await harness.root(ctx);
	await harness.commit(async (tx) => {
		await seed<project.V1>(tx, records.ProjectState, root.id, project.current);
		await seed<work.V1>(tx, records.WorkState, root.id, work.current);
	}, ctx);
	assert.deepEqual(
		await harness.snapshot(stateDoc(records.ProjectState), ctx),
		project.current,
	);
	const v2 = defineState({
		kind: "keel.work",
		scope: "conversation",
		version: 2,
		initial: (): { ledger: work.V1; revision: number } => ({
			ledger: { agents: {}, effects: {} },
			revision: 0,
		}),
		migrate(value: unknown, fromVersion: number) {
			assert.equal(fromVersion, 1);
			assert.deepEqual(value, work.current);
			return { ledger: value, revision: 1 };
		},
	});
	await harness.commit(async (tx) => {
		(await tx.doc(stateDoc(v2), root.id)).revision++;
	}, ctx);
	assert.deepEqual(await harness.snapshot(stateDoc(v2), root.id, ctx), {
		ledger: work.current,
		revision: 2,
	});
	await assert.rejects(
		harness.snapshot(stateDoc(records.WorkState), root.id, ctx),
		/version/i,
	);
});

test("state writes checkpoint at the 64th delta, not before", () => {
	const value = { runs: 1 };
	const spec = {
		kind: "keel.checkpoints",
		scope: "session",
		version: 1,
		initial: () => value,
	} as const;
	const checkpoint = stateDoc(defineState(spec)).definition.checkpointWhen;
	assert.equal(checkpoint(value, [], { deltasSinceBase: 0 }), false);
	assert.equal(checkpoint(value, [], { deltasSinceBase: 62 }), false);
	assert.equal(checkpoint(value, [], { deltasSinceBase: 63 }), true);
	assert.equal(checkpoint(value, [], { deltasSinceBase: 64 }), true);
});
