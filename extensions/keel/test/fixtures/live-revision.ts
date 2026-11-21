import assert from "node:assert/strict";
import { decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import type { JsonObject, Storage } from "tau/durable";
import { type FauxResponseStep, fauxAnswer } from "tau/testing";
import { ProjectState, WorkState } from "../../src/kernel/records.ts";
import { stateDoc } from "../../src/kernel/state.ts";
import { design } from "../../src/lanes/design/index.ts";
import { options } from "../../src/roles/index.ts";
import { runRepoEffect } from "../../src/workflow.ts";
import { git } from "../repo/fixture.ts";
import { latch } from "../toy.ts";
import { openScriptedWorkflow } from "./scenario.ts";

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
				options.set(tx, { ...(await options.get(tx)), max_workers: 2 }),
			ctx,
		);
	const project = () => harness.snapshot(stateDoc(ProjectState), ctx);
	const desk = () => harness.snapshot(stateDoc(design.state), work, ctx);
	async function asks() {
		return Object.values((await project())?.asks ?? {});
	}
	async function review(prefix: string) {
		const matching = (await asks()).filter((a) => a.local.startsWith(prefix));
		assert.equal(matching.length, 1, `one ${prefix} decision`);
		const d = await harness.commit(
			(tx) => decision(tx, matching[0]!.decision),
			ctx,
		);
		assert.ok(d?.status === "open");
		const basis = await harness.commit((tx) => tx.entry(d.basis), ctx);
		assert.ok(
			basis?.data && typeof basis.data === "object" && "text" in basis.data,
		);
		return { decision: d, text: String(basis.data.text) };
	}
	async function answer(
		prefix: string,
		choice: string,
		annotations: { text: string }[] = [],
	) {
		const { decision: d } = await review(prefix);
		const result = await fauxAnswer(s.store, d.id, {
			basis: d.basis,
			choice,
			annotations,
		});
		assert.equal(result.kind, "answered");
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
	const bash = (role: string, command: string, ...input: string[]) =>
		s.turn(role, "bash", { command }, ...input);
	const publish = (summary: string) =>
		s.turn("worker", "publish_build", { summary, addresses: [] });
	const pass = (text: string) =>
		s.turn("verifier", "publish_verdict", {
			outcome: "pass",
			blocks: [],
			notes: [],
			text,
		});
	const permitStats = () => statsGate.resolve();
	async function openTriage() {
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
			s.turn("designer", "publish_mandate", {
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
		]);
		await s.root.submit({ type: "input", content: intent }, ctx);
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
			}),
			brief(encode, "P1"),
			bash(
				"worker",
				"printf 'Book is tracked.\\n' > encode && git add encode && git commit -m 'encode book check'",
			),
			publish("Encoded the initial check"),
			pass("Initial check recorded."),
			...Array.from({ length: 7 }, () => point),
		]);
		s.queueProvider.setResponses([
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
						batchWith: [],
					},
					worker,
					report,
					finding,
					"wire",
				)(...args);
			},
		]);
		const approving = answer("mandate/", "approve");
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
				{ changes: { seams: [revised] }, replies: [] },
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
		const ledger = await harness.snapshot(stateDoc(WorkState), work, ctx);
		assert.equal(
			Object.values(ledger?.agents ?? {}).filter((a) => a.role === "designer")
				.length,
			1,
		);
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
					replies: [],
				},
				"frame_book prefix value",
			),
			brief(frame, "wire", "frame.sh"),
			bash(
				"worker",
				`printf '%s\\n' 'frame_book() { printf "%s:%s\\\\n" "$1" "$2"; }' > frame.sh && git add frame.sh && git commit -m 'encode framing'`,
				"frame_book prefix value",
			),
			publish("Added frame_book"),
			pass("Framing seam passes."),
			bash(
				"worker",
				`git merge --no-edit ${build} && . ./frame.sh && frame_book record repaired > book && git commit -am 'frame writer output'`,
				"frame_book prefix value",
			),
			publish("Framed the exported book"),
			pass("Export passes."),
			brief(revisedClient, "wire", "reader"),
			bash(
				"worker",
				"cut -d: -f2 book > reader && git add reader && git commit -m 'read the framed export'",
			),
			publish("Read the framed export"),
			pass("Framed reader passes."),
			s.turn("coordinator", "handoff_build", {
				summary: "Framed book and independent statistics",
				risk: "One framing scheme exercised.",
			}),
			bash(
				"verifier",
				"printf 'record:repaired\\n' | cmp - book && printf 'one\\n' | cmp - stats && printf 'repaired\\n' | cmp - reader",
			),
			pass("Framed book, reader and statistics pass together."),
		]);
		await s.settle();
		assert.equal(s.provider.getPendingResponseCount(), 0);
	}
	return {
		...s,
		harness,
		build,
		desk,
		asks,
		review,
		answer,
		permitStats,
		openTriage,
		propose,
		finish,
	};
}
