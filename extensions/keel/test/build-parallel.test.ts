import assert from "node:assert/strict";
import { test } from "node:test";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, MemoryStorage } from "tau/durable";
import { type FauxResponseStep, fauxAnswer } from "tau/testing";
import { ProjectState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import { options } from "../src/roles/index.ts";
import { runRepoEffect } from "../src/workflow.ts";
import { openScriptedWorkflow } from "./fixtures/scenario.ts";
import { fixture, git } from "./repo/fixture.ts";
import { latch } from "./toy.ts";

test("build two dependents concurrently from the first merge, merge serially, and hand over exactly the verified tree", {
	timeout: 15000,
}, async (t) => {
	const { root, base } = await fixture(t);
	const bothWorkers = latch<void>();
	const workers = new Set<string>();
	const briefed: string[] = [];
	const merges: string[] = [];
	const preparations: Record<string, string> = {};
	const reviews: string[] = [];
	let merging = false;
	const s = await openScriptedWorkflow(
		root,
		new MemoryStorage(),
		true,
		async (input, context, owner) => {
			const op = input.spec.op as JsonObject | undefined;
			if (op?.kind === "worktree") {
				const id = String(op.branch).match(/\/item\/([a-z]+)-1$/)?.[1];
				assert.ok(id);
				assert.ok(!(id in preparations), `no extra attempt for ${id}`);
				preparations[id] = String(op.base);
			}
			if (op?.kind === "checkout") reviews.push(String(op.sha));
			if (op?.kind !== "merge_item")
				return runRepoEffect(input, context, owner);
			assert.equal(merging, false, "merge effects do not overlap");
			merging = true;
			try {
				assert.equal(op.expected, merges.at(-1) ?? base);
				const result = await runRepoEffect(input, context, owner);
				assert.equal(result.kind, "merged");
				merges.push(String(result.sha));
				return result;
			} finally {
				merging = false;
			}
		},
	);
	const { harness } = s.store;
	t.after(async () => {
		bothWorkers.resolve();
		await harness.close(ctx);
	});
	await harness.commit(async (tx) => options.set(tx, { ...(await options.get(tx)), max_workers: 2 }), ctx);
	const build = `keel/${s.root.id}/build`;
	const intent = "Restore the book and add both independent indexes";
	const items = [
		{ id: "book", kind: "build", goal: "Restore the book", deps: [] },
		{ id: "left", kind: "build", goal: "Write the left index", deps: ["book"] },
		{
			id: "right",
			kind: "build",
			goal: "Write the right index",
			deps: ["book"],
		},
	];
	const brief = (id: string) =>
		s.turn("coordinator", "brief_item", {
			item: id,
			goal: `Write the ${id} content`,
			evidence: `Read ${id}`,
			fences: id,
			nodes: ["format"],
		});
	const verdict = s.turn("verifier", "publish_verdict", {
		outcome: "pass",
		blocks: [],
		notes: [],
		text: "The contents and dependencies match.",
	});
	const step: Extract<FauxResponseStep, (...args: never[]) => unknown> = async (
		...args
	) => {
		const [context, , , model] = args;
		const latest = JSON.stringify(
			context.messages.filter((m) => m.role === "user").at(-1),
		);
		const last = context.messages.at(-1);
		switch (model.id) {
			case "coordinator": {
				const item = items.find(({ id }) => latest.includes(`Item ${id} (build) is ready`));
				if (briefed.length < 2) {
					assert.ok(item && item.id !== "book");
					assert.equal(
						merges.length,
						1,
						"dependency gate before brief rendering",
					);
					assert.ok(latest.includes(merges[0]!));
					assert.ok(!briefed.includes(item.id));
					briefed.push(item.id);
					return brief(item.id)(...args);
				}
				assert.equal(merges.length, 3);
				return s.turn("coordinator", "handoff_build", {
					summary: intent,
					risk: "No other formats changed",
				})(...args);
			}
			case "worker": {
				const id = ["left", "right"].find((id) =>
					latest.includes(`Fences: ${id}`),
				);
				assert.ok(id);
				if (last?.role === "toolResult") {
					assert.equal(last.toolName, "bash");
					assert.equal(last.isError, false);
					return s.turn("worker", "publish_build", {
						summary: `Added ${id}`,
						addresses: [],
					})(...args);
				}
				assert.equal(
					merges.length,
					1,
					"neither dependent published before both started",
				);
				workers.add(id);
				if (workers.size === 2) bothWorkers.resolve();
				await bothWorkers.promise;
				return s.turn("worker", "bash", {
					command: `test "$(git rev-parse HEAD)" = ${merges[0]} && grep -qx restored book && printf '${id}\\n' > ${id} && git add ${id} && git commit -m 'add ${id} index'`,
				})(...args);
			}
			case "verifier":
				return verdict(...args);
			default:
				assert.fail(`Unexpected model ${model.id}`);
		}
	};
	s.provider.setResponses([
		s.turn("designer", "ground", {
			route: "follow",
			reference: "Approved format for all three files",
			mandate: {
				intent,
				nodes: [
					{
						label: "format",
						rule: "Write exactly one named line",
						probe: "Compare bytes",
					},
				],
				checks: [],
			},
		}),
		s.turn("coordinator", "publish_plan", { items }),
		brief("book"),
		s.turn("worker", "bash", {
			command: "printf 'restored\\n' > book && git commit -am 'restore book'",
		}),
		s.turn("worker", "publish_build", {
			summary: "Restored book",
			addresses: [],
		}),
		verdict,
		...Array.from({ length: 10 }, () => step),
	]);
	await s.root.submit({ type: "input", content: intent }, ctx);
	await s.settle();
	assert.equal(s.provider.getPendingResponseCount(), 0);
	assert.deepEqual([...workers].sort(), ["left", "right"]);
	assert.deepEqual(preparations, {
		book: base,
		left: merges[0],
		right: merges[0],
	});
	assert.equal(
		reviews.length,
		4,
		"one review per item, then full-set verification",
	);
	assert.equal(reviews[3], git(root, "rev-parse", build));
	const trunk = git(root, "rev-parse", "trunk");
	assert.equal(
		git(root, "rev-parse", `${reviews[3]}^{tree}`),
		git(root, "rev-parse", "trunk^{tree}"),
	);
	assert.equal(git(root, "log", "-1", "--format=%P", "trunk"), base);
	assert.equal(git(root, "rev-parse", "main"), base);
	assert.equal(git(root, "show", "trunk:book"), "restored");
	for (const id of ["left", "right"])
		assert.equal(git(root, "show", `trunk:${id}`), id);
	assert.equal(
		git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
		1,
	);
	const project = await harness.snapshot(stateDoc(ProjectState), ctx);
	const asks = Object.values(project?.asks ?? {});
	assert.equal(asks.length, 1);
	const handover = await harness.commit(
		(tx) => decision(tx, asks[0]!.decision),
		ctx,
	);
	assert.ok(handover?.status === "open");
	const basis = await harness.commit((tx) => tx.entry(handover.basis), ctx);
	assert.match(JSON.stringify(basis?.data), new RegExp(trunk));
	assert.equal(
		(
			await fauxAnswer(s.store, handover.id, {
				basis: handover.basis,
				choice: "accept",
				annotations: [],
			})
		).kind,
		"answered",
	);
	await s.settle();
	assert.deepEqual(
		(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks,
		{},
	);
});
