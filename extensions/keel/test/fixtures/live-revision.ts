import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import type { JsonObject, Storage } from "tau/durable";
import { type FauxResponseStep, fauxAssistantMessage } from "tau/testing";
import { stateDoc } from "../../src/kernel/state.ts";
import { design } from "../../src/lanes/design/index.ts";
import { options } from "../../src/roles/index.ts";
import { runRepoEffect } from "../../src/workflow.ts";
import { latch } from "../toy.ts";
import {
	arenaFrame,
	candidateResponse,
	judgeReport,
	seats,
} from "./arena-script.ts";
import { buildTurns } from "./build-turns.ts";
import { openScriptedWorkflow } from "./kernel.ts";
import { git } from "./repo.ts";

const intent = "Write a book export and an independent statistics file";
const report =
	"The existing reader cannot distinguish a raw value from its framing.";
const finding = "The writer seam needs a record prefix.";
const seam = {
	label: "wire",
	callersNow: "Shell exporter",
	callersLater: "Scheduled imports",
	usage: "```sh\nwrite_book repaired\n```",
	signature: "```sh\nwrite_book value\n```",
	owner: "Book export",
	dependencies: "POSIX shell",
};
const revised = {
	...seam,
	usage: "```sh\nframe_book record repaired\n```",
	signature: "```sh\nframe_book prefix value\n```",
	owner: "Framing module",
};
const goal = (id: string, goal: string, deps: string[], kind = "build") => ({
	id,
	goal,
	deps,
	kind,
});
const encode = goal(
	"encode",
	"Record the initial export contract",
	[],
	"encode",
);
const writer = goal("writer", "Write the book export", ["encode"]);
const stats = goal("stats", "Write independent statistics", ["encode"]);
const legacy = goal("legacy", "Add the raw export adapter", [
	"encode",
	"writer",
]);
const client = goal("client", "Consume the raw export", ["encode", "writer"]);
const frame = goal("frame", "Implement the record framing seam", ["encode"]);
const revisedClient = { ...client, goal: "Consume the framed export" };

export async function openLiveRevision(
	cwd: string,
	storage: Storage,
	first: boolean,
) {
	const statsGate = latch<void>();
	const investigationPrompt = latch<void>();
	const s = await openScriptedWorkflow(
		cwd,
		storage,
		first,
		async (input, context, owner) => {
			const op = input.spec.op as JsonObject | undefined;
			if (
				first &&
				op?.kind === "worktree" &&
				String(op.branch).includes("/item/stats-")
			)
				await statsGate.promise;
			return runRepoEffect(input, context, owner);
		},
	);
	const { harness } = s.store;
	const work = s.root.id;
	const build = `keel/${work}/build`;
	if (first)
		await harness.commit(
			async (tx) =>
				options.set(tx, {
					...(await options.get(tx)),
					max_workers: 2,
					queue_explorer: `explorer-fixture/${s.explorer.getModel().id}`,
				}),
			ctx,
		);
	const desk = () => {
		assert.equal(design.state.scope, "conversation");
		return harness.snapshot(stateDoc(design.state), work, ctx);
	};
	const review = (prefix: string) =>
		s.openAsk((a) => a.local.startsWith(prefix));
	async function answer(
		prefix: string,
		choice: string,
		annotations: { text: string }[] = [],
	) {
		await s.answer((await review(prefix)).d, choice, annotations);
		await s.settle();
	}
	const brief = (item: typeof writer, label: string, fences = item.id) =>
		s.turn(
			"coordinator",
			"brief_item",
			{
				item: item.id,
				goal: item.goal,
				nodes: [label],
				fences,
				evidence: `Check ${item.goal}.`,
			},
			item.goal,
		);
	const { bash, publish, pass, implement, verify } = buildTurns(s.turn);
	const permitStats = () => statsGate.resolve();
	async function openTriage() {
		s.secondCandidate.setResponses([candidateResponse(seats[1])]);
		s.judge.setResponses([fauxAssistantMessage(judgeReport)]);
		s.challenger.setResponses([fauxAssistantMessage('{"objections":[]}')]);
		s.provider.setResponses([
			s.turn("designer", "ground", {
				route: "precedent",
				reference: "No approved framing format",
				audit: {
					exists: "Book is already a text file.",
					gaps: [],
					contradictions: [],
				},
			}),
			s.turn("designer", "frame_arena", arenaFrame),
			candidateResponse(seats[0]),
			s.turn("designer", "publish_mandate", {
				base: seats[0],
				grafts: [],
				outcomes: [
					{
						source: seats[0],
						n: 1,
						reason: "The design has no naming default.",
					},
				],
				draft: {
					intent,
					done: "Book and statistics are exported.",
					seams: [seam],
					nodes: [
						{
							label: "statistics",
							rule: "Emit a separate statistics file.",
							probe: "Check stats.",
						},
					],
					never: "No duplicate exports.",
					tradeoffs: "Use shell functions.",
					alternatives: "A separate binary.",
					settlements: [],
					riders: [],
					references: [],
					checks: [{ id: "P1", argv: ["test", "-f", "book"], timeoutMs: 1000 }],
				},
				replies: [],
			}),
			s.turn("designer", "answer_challenger", { dispositions: [] }),
		]);
		await s.submit(intent);
		await s.settle();
		const point: Extract<FauxResponseStep, (...args: never[]) => unknown> = (
			...args
		) => {
			const [context, , , model] = args;
			const last = context.messages.at(-1);
			const latest = JSON.stringify(
				context.messages.filter((m) => m.role === "user").at(-1),
			);
			if (model.id === "coordinator") {
				if (latest.includes(writer.goal))
					return brief(writer, "wire", "book")(...args);
				return brief(stats, "statistics")(...args);
			}
			if (model.id === "verifier")
				return pass("Independent statistics pass.")(...args);
			assert.equal(model.id, "worker");
			if (latest.includes(writer.goal)) {
				if (last?.role !== "toolResult")
					return bash(
						"worker",
						"printf 'draft\\n' > book && git commit -am 'draft writer'",
						"write_book repaired",
					)(...args);
				return s.turn("worker", "file_finding", {
					text: finding,
					report,
					nodes: ["wire"],
					blocking: true,
				})(...args);
			}
			if (last?.role === "toolResult")
				return publish("Added independent statistics")(...args);
			return bash(
				"worker",
				"printf 'one\\n' > stats && git add stats && git commit -m 'add statistics'",
				"Emit a separate statistics file.",
			)(...args);
		};
		s.provider.setResponses([
			s.turn("coordinator", "publish_plan", {
				items: [encode, writer, stats, legacy, client],
				replies: [
					{
						n: 1,
						status: "acted_on",
						reason: "First plan keeps an independent statistics check.",
					},
				],
			}),
			brief(encode, "P1"),
			...implement(
				"printf 'Book is tracked.\\n' > encode && git add encode && git commit -m 'encode book check'",
				"Encoded the initial check",
			),
			pass("Initial check recorded."),
			...Array.from({ length: 7 }, () => point),
		]);
		const explorerResult =
			"The current writer and reader use the bound wire seam.";
		s.explorer.setResponses([
			(context) => {
				const evidence = JSON.stringify(context);
				assert.match(evidence, /write_book value/);
				assert.match(evidence, /Write independent statistics/);
				return fauxAssistantMessage(explorerResult);
			},
		]);
		s.queueProvider.setResponses([
			s.turn(
				"investigator",
				"dispatch",
				{
					jobs: [
						{
							seat: "queue_explorer",
							question: "What authority governs the writer?",
						},
					],
				},
				report,
			),
			(...args) => {
				const worker = git(cwd, "rev-parse", `keel/${work}/item/writer-1`);
				investigationPrompt.resolve();
				return s.turn(
					"investigator",
					"report_investigation",
					{
						finding: 1,
						classification: "mandate_wrong",
						evidence:
							"Reproduced: the reader cannot distinguish the raw record.",
						size: "small",
						cause: "ambiguous framing",
						recommendation: "build",
						reference: "Book reader contract",
						nodes: ["wire"],
					},
					worker,
					report,
					finding,
					"wire",
					{ tool: "dispatch", text: explorerResult },
				)(...args);
			},
		]);
		const approving = answer("mandate/", "approve", [
			{ text: "Keep statistics independent." },
		]);
		try {
			await Promise.race([
				investigationPrompt.promise,
				approving.then(() => assert.fail("investigation was not delivered")),
			]);
			const deliveries = await harness.commit(
				(tx) => tx.scanTasks({ kind: "keel.deliver" }, 100),
				ctx,
			);
			const queue = deliveries.items.find(
				(d) => (d.input as JsonObject).lane === "queue",
			);
			assert.ok(queue);
			await harness.waitForTask(queue.id, ctx);
			assert.match(
				(await review("triage/")).text,
				/ambiguous framing|cannot distinguish/,
			);
			assert.throws(() => git(cwd, "show", `${build}:stats`));
		} finally {
			permitStats();
		}
		await approving;
		assert.equal(
			git(cwd, "show", `${build}:stats`),
			"one",
			"unaffected work merged while triage was open",
		);
		assert.equal(
			git(cwd, "show", `${build}:book`),
			"old",
			"the affected draft did not merge",
		);
		assert.equal(
			git(cwd, "for-each-ref", `refs/heads/keel/${work}/item/legacy-*`),
			"",
		);
		assert.equal(s.provider.getPendingResponseCount(), 0);
		assert.equal(s.queueProvider.getPendingResponseCount(), 0);
	}
	async function propose() {
		s.provider.setResponses([
			s.turn(
				"designer",
				"publish_revision",
				{
					changes: { seams: [revised] },
					answers: [
						{
							cause: "queue/1",
							nodes: ["wire"],
							reason: "The framed call distinguishes the new export format.",
						},
					],
					replies: [],
				},
				finding,
				report,
				"wire",
			),
		]);
		await s.settle();
		assert.equal(s.provider.getPendingResponseCount(), 0);
		const { text } = await review("revision/");
		for (const snippet of ["wire", seam.usage, revised.usage, report])
			assert.ok(text.includes(snippet), text);
		assert.doesNotMatch(text, /Emit a separate statistics file/);
		const results = (await s.root.entries({}, 100, undefined, ctx)).items
			.flatMap((e) => e.model ?? [])
			.filter(
				(m) => m.role === "toolResult" && m.toolName === "publish_revision",
			);
		assert.equal(results.length, 1, "one proposal after restart");
	}
	async function finish() {
		s.provider.setResponses([
			s.turn(
				"coordinator",
				"publish_plan",
				{
					items: [
						encode,
						stats,
						frame,
						{ ...writer, deps: ["encode", "frame"] },
						revisedClient,
					],
					replies: [
						{
							n: 1,
							status: "acted_on",
							reason: "Revision plan adds a framing item before the writer.",
						},
					],
				},
				"frame_book prefix value",
				"Held items",
				"Affected items",
				"Recorded items",
			),
			brief(frame, "wire", "frame.sh"),
			...implement(
				`printf '%s\\n' 'frame_book() { printf "%s:%s\\\\n" "$1" "$2"; }' > frame.sh && git add frame.sh && git commit -m 'encode framing'`,
				"Added frame_book",
				"frame_book prefix value",
			),
			pass("Framing seam passes."),
			...implement(
				`git merge --no-edit ${build} && . ./frame.sh && frame_book record repaired > book && git commit -am 'frame writer output'`,
				"Framed the exported book",
				"frame_book prefix value",
			),
			pass("Export passes."),
			brief(revisedClient, "wire", "reader"),
			...implement(
				"cut -d: -f2 book > reader && git add reader && git commit -m 'read the framed export'",
				"Read the framed export",
			),
			pass("Framed reader passes."),
			s.turn("coordinator", "handoff_build", {
				summary: "Framed book and independent statistics",
				risk: "One framing scheme exercised.",
			}),
			...verify(
				"printf 'record:repaired\\n' | cmp - book && printf 'one\\n' | cmp - stats && printf 'repaired\\n' | cmp - reader",
				"Framed book, reader and statistics pass together.",
			),
		]);
		await s.settle();
		assert.equal(s.provider.getPendingResponseCount(), 0);
	}
	return {
		build,
		desk,
		asks: s.asks,
		close: s.close,
		commit: s.commit,
		review,
		answer,
		permitStats,
		openTriage,
		propose,
		finish,
	};
}
