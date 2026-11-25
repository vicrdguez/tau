import assert from "node:assert/strict";
import { test } from "node:test";
import { eventLog } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { type JsonObject, MemoryStorage } from "tau/durable";
import type { FauxResponseStep } from "tau/testing";
import { arenaFrame } from "./fixtures/arena-script.ts";
import { openScriptedWorkflow } from "./fixtures/kernel.ts";
import { tempRepo } from "./fixtures/repo.ts";
import { latch } from "./toy.ts";

for (const stage of ["candidates", "prototypes"] as const) {
	test(`cancel during ${stage} stops both children before the final cleanup note`, {
		timeout: 5000,
	}, async (t) => {
		const { root } = await tempRepo(t);
		const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
		const { harness } = s.store;
		t.after(s.close);
		const started = [latch<void>(), latch<void>()];
		const aborted: number[] = [];
		const hanging =
			(i: number): FauxResponseStep =>
			(_call, options) => {
				started[i]!.resolve();
				return new Promise((_resolve, reject) =>
					options?.signal?.addEventListener(
						"abort",
						() => {
							aborted.push(i);
							reject(options.signal?.reason);
						},
						{ once: true },
					),
				);
			};
		s.provider.setResponses([
			s.turn("designer", "ground", {
				route: "precedent",
				reference: "No approved writer.",
				audit: { exists: "A book exists.", gaps: [], contradictions: [] },
			}),
			stage === "candidates"
				? s.turn("designer", "frame_arena", arenaFrame)
				: s.turn("designer", "start_experiment", {
						node: "encoding",
						question: "What fits?",
						decisionRule: "Fewest bytes wins.",
						controls: ["Same inputs"],
						axis: "format",
						variants: ["plain", "compact"],
					}),
			hanging(0),
			...(stage === "prototypes" ? [hanging(1)] : []),
		]);
		s.secondCandidate.setResponses([hanging(1)]);
		harness.resume();
		await s.submit("Give shell callers one writer.");
		await Promise.all(started.map((child) => child.promise));
		s.provider.setResponses([s.turn("designer", "request_cancel", {})]);
		await (await s.submit("Cancel this work, please.")).wait(ctx);
		const [slot] = await s.asks();
		assert.ok(slot);
		const { d } = await s.readAsk(slot);
		assert.deepEqual(aborted, [], "nothing stops before the owner answers");
		let abortedAtNote: number[] | undefined;
		const log = await harness.commit(eventLog, ctx);
		const observer = harness.observeCommits({
			advance: ({ changes }) => {
				if (
					changes.some(
						(c) =>
							c.type === "entry" &&
							c.value.conversationId === log &&
							c.value.kind === "keel.event" &&
							String((c.value.data as JsonObject).text).includes(
								"Cancellation cleanup finished",
							),
					)
				)
					abortedAtNote = [...aborted].sort();
			},
			end() {},
		});
		t.after(() => observer.detach());
		await s.answer(d, "cancel");
		await s.settle();
		assert.deepEqual(
			abortedAtNote,
			[0, 1],
			"both requests stopped before cleanup was reported",
		);
		const { items } = await harness.commit(
			(tx) => tx.scanEntries({ conversationId: log }, 100),
			ctx,
		);
		const notes = items
			.map((entry) => String((entry.data as JsonObject).text))
			.filter((text) => text.includes("Cancellation cleanup finished"));
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /stopped the dispatch stage and its children/i);
	});
}
