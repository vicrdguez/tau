import assert from "node:assert/strict";
import { access, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import { MemoryStorage } from "tau/durable";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "tau/testing";
import { ProjectState } from "../src/kernel/records.ts";
import { stateDoc } from "../src/kernel/state.ts";
import {
	arenaFrame,
	candidateResponse,
	judgeReport,
	seats,
} from "./fixtures/arena-script.ts";
import { openScriptedWorkflow } from "./fixtures/scenario.ts";
import { fixture } from "./repo/fixture.ts";

test("protocol-first prototypes use separate scratch directories and put the comparison and winning rider in the node's review", {
	timeout: 5000,
}, async (t) => {
	const { root } = await fixture(t);
	const s = await openScriptedWorkflow(root, new MemoryStorage(), true);
	const { harness } = s.store;
	t.after(() => harness.close(ctx));
	const paths = new Map<string, string>();
	t.after(async () => {
		for (const path of paths.values())
			await rm(path, { recursive: true, force: true });
	});
	const prototype: FauxResponseStep = ({ messages }) => {
		const prompt = JSON.stringify(messages.find((m) => m.role === "user"));
		assert.match(prompt, /Prefer fewer bytes for the same payload/);
		const variant = prompt.includes("scratch-plain")
			? "scratch-plain"
			: "scratch-compact";
		const last = messages.at(-1);
		if (last?.role !== "toolResult")
			return fauxAssistantMessage(
				[
					fauxToolCall("bash", {
						command: `pwd; printf '%s' ${variant} > specimen; wc -c < specimen`,
					}),
				],
				{ stopReason: "toolUse" },
			);
		assert.equal(last.isError, false);
		const block = last.content[0];
		assert.ok(block?.type === "text");
		paths.set(variant, block.text.split("\n")[0]!);
		return fauxAssistantMessage(
			JSON.stringify({
				observation: `${variant} measured`,
				evidence: block.text,
				incidentalChoices: [
					variant === "scratch-plain"
						? "Use plain naming"
						: "Use compact naming",
				],
			}),
		);
	};
	s.secondCandidate.setResponses([candidateResponse(seats[1])]);
	s.judge.setResponses([fauxAssistantMessage(judgeReport)]);
	s.challenger.setResponses([fauxAssistantMessage('{"objections":[]}')]);
	s.provider.setResponses([
		s.turn("designer", "ground", {
			route: "precedent",
			reference: "No approved representation",
			audit: { exists: "A book exists.", gaps: [], contradictions: [] },
		}),
		s.turn("designer", "start_experiment", {
			node: "representation",
			question: "Which representation uses fewer bytes?",
			decisionRule: "Prefer fewer bytes for the same payload",
			controls: ["The payload is identical"],
			axis: "encoding",
			variants: ["scratch-plain", "scratch-compact"],
		}),
		prototype,
		prototype,
		prototype,
		prototype,
		s.turn(
			"designer",
			"record_experiment",
			{
				comparison: "The plain specimen is smaller under the written rule.",
				winner: "scratch-plain",
			},
			"scratch-plain measured",
			"scratch-compact measured",
		),
		s.turn("designer", "frame_arena", arenaFrame),
		candidateResponse(seats[0]),
		s.turn("designer", "publish_mandate", {
			base: seats[0],
			grafts: [],
			outcomes: [
				{
					source: seats[0],
					n: 1,
					reason: "The representation does not prescribe names.",
				},
				{ source: "experiment-1", n: 1, label: "plain-naming" },
			],
			replies: [],
			draft: {
				intent: "Represent the book without losing bytes",
				done: "The representation round-trips.",
				nodes: [
					{
						label: "representation",
						rule: "Use plain encoding",
						probe: "Compare round-trip bytes",
					},
				],
				checks: [
					{ id: "probe", argv: ["test", "-f", "book"], timeoutMs: 1000 },
				],
				never: "No loss",
				tradeoffs: "Use plain records",
				alternatives: "Compact records use more bytes",
				seams: [],
				settlements: [],
				riders: [
					{
						label: "plain-naming",
						text: "Use plain naming",
						origin: "incidental",
						disposition: "open",
					},
				],
				references: [],
			},
		}),
		s.turn("designer", "answer_challenger", { dispositions: [] }),
	]);
	await s.root.submit(
		{ type: "input", content: "Find the smaller representation" },
		ctx,
	);
	await s.settle();
	assert.equal(paths.size, 2);
	assert.equal(new Set(paths.values()).size, 2);
	for (const [variant, path] of paths) {
		assert.ok(
			path.startsWith(join(await realpath(tmpdir()), "keel-prototype-")),
		);
		assert.equal(await readFile(join(path, "specimen"), "utf8"), variant);
	}
	await assert.rejects(access(join(root, "specimen")), { code: "ENOENT" });
	const open = (await harness.snapshot(stateDoc(ProjectState), ctx))?.asks;
	const slot = Object.values(open ?? {})[0];
	assert.ok(slot && slot.local === "mandate/1");
	const ask = await harness.commit((tx) => decision(tx, slot.decision), ctx);
	assert.ok(ask?.status === "open");
	const basis = await harness.commit((tx) => tx.entry(ask.basis), ctx);
	const text = (basis?.data as { text: string }).text;
	assert.match(
		text,
		/## Evidence \(does not bind\)[\s\S]*representation[\s\S]*The plain specimen is smaller under the written rule/,
	);
	assert.match(
		text,
		/plain-naming: Rider[\s\S]*Use plain naming[\s\S]*Disposition: open/,
	);
	assert.match(text, /Use plain naming[\s\S]*Rider `plain-naming`/);
	assert.ok(!text.includes("experiment-1-r2: Rider"));
});
