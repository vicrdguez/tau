import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId, JsonObject } from "tau/durable";
import { workId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { buildLane } from "../src/lanes/build/index.ts";
import type { Mandate } from "../src/lanes/design/public.ts";
import { drive } from "./fixtures/drive.ts";

const work = workId(32 as ConversationId);
const base = "a".repeat(40);
const tip = "b".repeat(40);
const mandate: Mandate = {
	intent: "Keep balanced accounts",
	encodeRequired: false,
	approvalNotes: [],
	delegated: [],
	considerations: null,
	nodes: [
		{ label: "ledger", rule: "Old ledger crossing", probe: "old probe" },
		{ label: "report", rule: "Stable reporting", probe: "report probe" },
	],
	checks: [],
};
const revised: Mandate = {
	...mandate,
	nodes: [
		{ label: "ledger", rule: "New ledger crossing", probe: "new probe" },
		mandate.nodes[1]!,
	],
	approvalNotes: ["Test tie values"],
};
const reply = [{ n: 1, status: "acted_on", reason: "Add a tie case" }];
const goal = (id: string, deps: string[] = [], text = `Goal for ${id}`) => ({
	id,
	kind: "build",
	goal: text,
	deps,
});
const hold = (cause: string, item: string | null, nodes: string[] = []) => ({
	kind: "queue_hold",
	cause,
	item,
	nodes,
	evidence: "evidence attached to this cause",
});
const release = (cause: string, direction = "Carry on") => ({
	kind: "queue_release",
	cause,
	direction,
});
const proposal = {
	kind: "propose_revision",
	mandate: revised,
	causes: ["queue/1"],
	nodes: ["ledger"],
	text: "Correct the ledger crossing",
};
function setup(
	items: ReturnType<typeof goal>[],
	max_workers = 2,
	initial = mandate,
	initialReplies: JsonObject[] = [],
) {
	const world: World = {
		work,
		root: "/repo",
		now: 0,
		view: () => null,
		options: {
			design: "a/a",
			build: "b/b",
			verify: "c/c",
			queue: "d/d",
			base: "main",
			trunk: "trunk",
			max_workers,
		},
	};
	return buildLane.use((lane) => {
		let state = lane.state.initial();
		const tryEvent = (event: LaneEvent) => drive(lane, state, event, world);
		const send = (event: LaneEvent) => {
			const r = tryEvent(event);
			if ("reject" in r) assert.fail(r.reject);
			state = r.state;
			return r.send ?? [];
		};
		const agents = () => lane.agents(state, world);
		const coord = () =>
			agents().find((a) => a.role === "coordinator")?.expects[0];
		const workers = () => agents().filter((a) => a.role === "worker");
		const worker = (item: string) =>
			workers().find((a) => a.key.startsWith(`worker/${item}/`));
		const effects = () => lane.effects(state, world);
		const done = (result: JsonObject, key = effects()[0]?.key) => {
			assert.ok(key, "an effect is due");
			return send({ kind: "effect_done", key, result });
		};
		const plan = (
			items: ReturnType<typeof goal>[],
			replies: JsonObject[] = [],
			fixes: JsonObject[] = [],
		) => send({ kind: "plan", items, replies, fixes });
		const brief = (item: string, label = "ledger") =>
			send({
				kind: "brief",
				item,
				goal: `Brief for ${item}`,
				evidence: `Probe ${item}`,
				fences: `src/${item}.ts`,
				nodes: [label],
			});
		const ready = () => done({ kind: "worktree", base, principles: [] });
		const publish = (id: string, changedPolicyFiles: string[] = []) => {
			const a = worker(id);
			assert.ok(a);
			return send({
				kind: "publish",
				agent: a.key,
				summary: `Patched ${id}`,
				addresses: [],
				facts: { kind: "ok", sha: "c".repeat(40), base, changedPolicyFiles },
			});
		};
		const merge = (item: string) => {
			send({ kind: "merged", item, head: tip });
			done({ kind: "removed" });
		};
		send({ kind: "bound", mandate: initial });
		done({
			kind: "repo",
			repo: {
				root: "/repo",
				commonDir: "/repo/.git",
				base: "main",
				trunk: "trunk",
				baseHead: base,
				trunkHead: base,
			},
		});
		done({ kind: "started", base });
		plan(items, initialReplies);
		return {
			send,
			tryEvent,
			coord,
			worker,
			workers,
			effects,
			done,
			plan,
			brief,
			ready,
			publish,
			merge,
			view: () => lane.view(state),
			restore: () => {
				state = JSON.parse(JSON.stringify(state));
			},
		};
	});
}

test("the investigator can distinguish planned goals from actual briefs", () => {
	const b = setup([goal("first"), goal("later", ["first"])]);
	b.brief("first");
	const { plan } = b.view() as {
		plan: { id: string; goal: string; brief: { nodes: string[] } | null }[];
	};
	assert.deepEqual(
		plan.map(({ id, goal, brief }) => [id, goal, brief?.nodes ?? null]),
		[
			["first", "Goal for first", ["ledger"]],
			["later", "Goal for later", null],
		],
	);
});

test("a blocking filer holds only itself, classification extends that cause, and releasing one cause cannot release another", () => {
	const b = setup([goal("filer"), goal("related"), goal("sibling")], 3);
	for (const [item, label] of [
		["filer", "report"],
		["related", "ledger"],
		["sibling", "report"],
	] as const) {
		b.brief(item, label);
		b.ready();
	}
	const token = b.worker("filer")?.expects[0]?.token;
	b.send(hold("queue/1", "filer"));
	assert.deepEqual(
		b
			.workers()
			.filter((a) => a.paused)
			.map((a) => a.key),
		["worker/filer/1"],
	);
	b.send(hold("queue/1", null, ["ledger"]));
	b.send(hold("queue/2", "related"));
	assert.deepEqual(
		b
			.workers()
			.filter((a) => a.paused)
			.map((a) => a.key),
		["worker/filer/1", "worker/related/1"],
	);
	b.send(release("queue/1", "Keep the existing report"));
	assert.equal(b.worker("filer")?.paused, false);
	assert.notEqual(b.worker("filer")?.expects[0]?.token, token);
	assert.match(
		b.worker("filer")?.expects[0]?.input?.() ?? "",
		/Keep the existing report/,
	);
	assert.equal(b.worker("related")?.paused, true);
	assert.equal(b.worker("sibling")?.paused, false);
});

test("a classified node is durable before it has a brief, cannot start a checkout, and does not reserve the only slot", () => {
	const b = setup([goal("affected"), goal("other")], 1);
	b.send(hold("queue/1", null, ["ledger"]));
	b.restore();
	b.brief("affected");
	assert.deepEqual(b.effects(), []);
	assert.match(b.coord()?.input?.() ?? "", /Goal for other/);
	b.brief("other", "report");
	b.ready();
	b.send(release("queue/1"));
	assert.deepEqual(b.effects(), []);
	b.publish("other");
	b.merge("other");
	assert.match(b.coord()?.input?.() ?? "", new RegExp(tip));
	b.brief("affected");
	assert.equal((b.effects()[0]?.spec.op as JsonObject)?.base, tip);
});

test("a claimed preparation can finish while held, but its worker waits for a slot after release", () => {
	const b = setup([goal("affected"), goal("other")], 1);
	b.brief("affected");
	const preparing = b.effects()[0]?.key;
	assert.ok(preparing);
	b.send(hold("queue/1", "affected"));
	b.done({ kind: "worktree", base, principles: [] }, preparing);
	assert.equal(b.worker("affected")?.paused, true);
	b.brief("other", "report");
	b.ready();
	b.send(release("queue/1"));
	assert.equal(b.worker("affected")?.paused, true);
	b.publish("other");
	b.merge("other");
	assert.equal(b.worker("affected")?.paused, false);
	assert.equal(b.worker("affected")?.key, "worker/affected/1");
});

test("a held publication signals Verify exactly once per named cause and only releases that cause", () => {
	const b = setup([goal("item")]);
	b.brief("item");
	b.ready();
	b.publish("item");
	const verify = (event: LaneEvent) => [{ lane: "verify", work, event }];
	const signal = (cause: string) =>
		verify({
			kind: "queue_hold",
			cause,
			item: "item",
			evidence: "evidence attached to this cause",
		});
	assert.deepEqual(b.send(hold("queue/1", "item")), signal("queue/1"));
	assert.deepEqual(b.send(hold("queue/1", null, ["ledger"])), []);
	assert.deepEqual(
		b.send(hold("queue/2", null, ["ledger"])),
		signal("queue/2"),
	);
	assert.deepEqual(
		b.send(release("queue/1")),
		verify({ kind: "queue_release", cause: "queue/1", direction: "Carry on" }),
	);
	assert.equal(b.worker("item")?.paused, true);
	assert.deepEqual(b.send(release("queue/1")), []);
});

test("discovered work is planned without an owner decision, preserves existing goals, and retains findings arriving during planning", () => {
	const b = setup([goal("original")]);
	const finding = {
		kind: "plan_finding",
		text: "Patch the duplicate entry",
		reference: "Approved ledger spec",
		nodes: ["ledger"],
		cause: "queue/1",
	};
	const next = {
		...finding,
		text: "Fix the extra decrement",
		cause: "queue/2",
	};
	assert.deepEqual(b.send(finding), []);
	assert.deepEqual(b.coord()?.tools, ["publish_plan"]);
	assert.match(
		b.coord()?.input?.() ?? "",
		/Patch the duplicate entry[\s\S]*Approved ledger spec/,
	);
	assert.ok(
		"reject" in
			b.tryEvent({ kind: "plan", items: [goal("original", [], "overwrite")] }),
	);
	b.send(next);
	b.plan([goal("patch")]);
	assert.deepEqual(b.coord()?.tools, ["publish_plan"]);
	assert.match(b.coord()?.input?.() ?? "", /Fix the extra decrement/);
	b.plan([goal("decrement")]);
	assert.match(b.coord()?.input?.() ?? "", /Goal for original/);
});

test("a finding sent after handoff seeds follow-on work with its approved reference", () => {
	const b = setup([goal("item")]);
	b.brief("item");
	b.ready();
	b.publish("item");
	b.merge("item");
	b.send({ kind: "handoff", summary: "One commit", risk: "Low" });
	const routes = b.send({
		kind: "plan_finding",
		text: "Patch audit totals",
		reference: "Approved audit spec",
		nodes: ["ledger"],
	});
	assert.equal(routes.length, 1);
	assert.deepEqual(
		[
			routes[0]?.lane,
			routes[0]?.work,
			routes[0]?.event.route,
			routes[0]?.event.text,
			routes[0]?.event.reference,
		],
		["design", "new", "follow", "Patch audit totals", "Approved audit spec"],
	);
});

test("revision activation and the edited plan take effect together, retaining a held attempt until its new dependency merges", () => {
	const affected = goal("affected");
	const b = setup([
		affected,
		goal("other"),
		goal("drop", ["affected"]),
		goal("later", ["affected"]),
	]);
	b.brief("affected");
	b.ready();
	b.brief("other", "report");
	b.ready();
	b.send(hold("queue/1", null, ["ledger"]));
	assert.deepEqual(b.send(proposal), []);
	assert.match(b.coord()?.input?.() ?? "", /New ledger crossing/);
	assert.match(b.coord()?.input?.() ?? "", /1\. Test tie values/);
	const other = b.publish("other")[0]?.event;
	assert.deepEqual(other?.mandate, mandate);
	b.merge("other");
	const dep = goal("dependency");
	const later = goal("later", ["affected"], "Edited later goal");
	const replacement = [
		later,
		dep,
		{ ...affected, deps: ["dependency"] },
		goal("other"),
	];
	for (const [items, replies] of [
		[replacement, []],
		[[...replacement.slice(0, 3)], reply],
		[[...replacement.slice(0, 3), goal("other", [], "rewrite history")], reply],
		[[...replacement.slice(0, 3), goal("other", ["dependency"])], reply],
		[[later, goal("dependency", ["affected"]), ...replacement.slice(2)], reply],
	] as const) {
		assert.ok(
			"reject" in
				b.tryEvent({ kind: "plan", items: [...items], replies: [...replies] }),
		);
		assert.equal(b.worker("affected")?.paused, true);
	}
	const activation = b.plan(replacement, reply);
	assert.deepEqual(
		activation.map(({ lane, event }) => [lane, event.kind]),
		[
			["verify", "mandate_revised"],
			["design", "revision_activated"],
		],
	);
	assert.deepEqual(activation[0]?.event.mandate, revised);
	assert.deepEqual(activation[1]?.event.causes, ["queue/1"]);
	assert.equal(b.worker("affected")?.paused, true);
	assert.match(b.coord()?.input?.() ?? "", /Goal for dependency/);
	b.brief("dependency", "report");
	b.ready();
	b.publish("dependency");
	b.merge("dependency");
	assert.equal(b.worker("affected")?.key, "worker/affected/1");
	assert.match(
		b.worker("affected")?.expects[0]?.input?.() ?? "",
		/New ledger crossing/,
	);
	assert.match(
		b.worker("affected")?.expects[0]?.input?.() ?? "",
		/Correct the ledger crossing/,
	);
	b.publish("affected");
	b.merge("affected");
	assert.match(b.coord()?.input?.() ?? "", /Edited later goal/);
	b.brief("later");
	b.ready();
	b.publish("later");
	b.merge("later");
	assert.deepEqual(b.coord()?.tools, ["handoff_build"]);
});

test("the approved revision holds every affected brief, including a removed node the investigator did not name", () => {
	const first = goal("first");
	const report = goal("report");
	const b = setup([first, report]);
	b.brief(first.id);
	b.ready();
	b.brief(report.id, "report");
	b.ready();
	b.send(hold("queue/1", null, ["ledger"]));
	b.send({
		...proposal,
		nodes: ["ledger", "report"],
		mandate: { ...revised, nodes: [revised.nodes[0]!] },
	});
	assert.equal(b.worker(report.id)?.paused, true);
	const correction = goal("new-reporter");
	b.plan([first, { ...report, deps: [correction.id] }, correction], reply);
	assert.equal(b.worker(report.id)?.paused, true);
	b.brief(correction.id);
	b.ready();
	b.publish(correction.id);
	b.merge(correction.id);
	const input = b.worker(report.id)?.expects[0]?.input?.() ?? "";
	assert.match(input, /New ledger crossing/);
	assert.doesNotMatch(input, /Stable reporting/);
	assert.doesNotMatch(input, /Mandate nodes: report/);
});

test("a verified item awaiting merge is a record: require a separate correction depending on it", () => {
	const original = goal("verified");
	const b = setup([original]);
	b.brief("verified");
	b.ready();
	b.publish("verified");
	b.send({ kind: "item_verified", item: "verified" });
	b.send(hold("queue/1", null, ["ledger"]));
	b.send(proposal);
	assert.ok(
		"reject" in b.tryEvent({ kind: "plan", items: [original], replies: reply }),
	);
	assert.ok(
		"reject" in
			b.tryEvent({
				kind: "plan",
				items: [original, goal("correction")],
				replies: reply,
			}),
	);
	const activation = b.plan(
		[original, goal("correction", ["verified"])],
		reply,
	);
	assert.deepEqual(
		activation.find((m) => m.event.kind === "mandate_revised")?.event.items,
		[],
	);
	assert.ok(
		activation.some(
			(m) => m.event.kind === "queue_release" && m.event.cause === "queue/1",
		),
	);
	assert.equal(b.coord(), undefined);
	b.merge("verified");
	assert.match(b.coord()?.input?.() ?? "", /Goal for correction/);
});

test("a held unverified publication is superseded before release; its original worker waits for revised dependencies", () => {
	const original = goal("pending");
	const b = setup([original]);
	b.brief("pending");
	b.ready();
	b.publish("pending", [".keel/playbooks/verification.md"]);
	b.send(hold("queue/1", null, ["ledger"]));
	b.send(proposal);
	const activation = b.plan(
		[{ ...original, deps: ["dependency"] }, goal("dependency")],
		reply,
	);
	const update = activation.findIndex(
		(m) => m.event.kind === "mandate_revised",
	);
	assert.deepEqual(activation[update]?.event.items, ["pending"]);
	const unhold = activation.findIndex((m) => m.event.kind === "queue_release");
	assert.ok(unhold < 0 || update < unhold);
	b.send({
		kind: "rework",
		item: "pending",
		head: base,
		evidence: "Recheck publication after the Mandate change",
		threads: [],
	});
	assert.equal(b.worker("pending")?.paused, true);
	b.brief("dependency", "report");
	b.ready();
	b.publish("dependency");
	b.merge("dependency");
	assert.equal(b.worker("pending")?.paused, false);
	assert.match(
		b.worker("pending")?.expects[0]?.input?.() ?? "",
		/New ledger crossing/,
	);
	const republication = b.publish("pending", [
		".keel/playbooks/verification.md",
	]);
	assert.deepEqual(republication[0]?.event.changedPolicyFiles, [
		".keel/playbooks/verification.md",
	]);
});

test("handoff keeps original and revision approval notes with unique numbers and their own replies", () => {
	const item = goal("ledger");
	const firstReply = {
		n: 1,
		status: "considered",
		reason: "Confirm negatives",
	};
	const b = setup(
		[item],
		2,
		{ ...mandate, approvalNotes: ["Check negatives"] },
		[firstReply],
	);
	b.send(hold("queue/1", null, ["ledger"]));
	b.send(proposal);
	b.plan([item], reply);
	b.brief(item.id);
	b.ready();
	b.publish(item.id);
	b.merge(item.id);
	const handoff = b.send({
		kind: "handoff",
		summary: "Ledger done",
		risk: "None",
	})[0]!.event;
	assert.deepEqual((handoff.mandate as Mandate).approvalNotes, [
		"Check negatives",
		"Test tie values",
	]);
	assert.deepEqual(handoff.approvalReplies, [
		firstReply,
		{ ...reply[0], n: 2 },
	]);
});

test("a stalled worker resumes with both the revision instructions and the owner's new direction", () => {
	const item = goal("ledger");
	const b = setup([item]);
	b.brief(item.id);
	b.ready();
	b.send(hold("queue/1", null, ["ledger"]));
	b.send(proposal);
	b.plan([item], reply);
	const worker = b.worker(item.id)!;
	const filed = b.send({
		kind: "agent_stalled",
		agent: worker.key,
		cause: "stopped",
		tokens: [worker.expects[0]!.token],
		lastWords: "need direction",
	})[0]!.event;
	b.send({ ...filed, kind: "resume", direction: "Start with negatives." });
	const input = b.worker(item.id)!.expects[0]!.input!();
	assert.match(input, /Correct the ledger crossing/);
	assert.match(input, /Start with negatives/);
});

test("a worker whose publication is superseded is told the Mandate changed, not that verification found a defect", () => {
	const b = setup([goal("ledger")]);
	b.brief("ledger");
	b.ready();
	b.publish("ledger");
	b.send({
		kind: "rework",
		item: "ledger",
		head: base,
		evidence: "The ledger crossing changed.",
		threads: [],
		reason: "mandate_revision",
	});
	const input = b.worker("ledger")!.expects[0]!.input!();
	assert.match(input, /^The Mandate changed/);
	assert.match(input, /The ledger crossing changed/);
	assert.doesNotMatch(input, /Verification found a defect/);
});

test("a blocked defect filer stays held through fix validation and publication, then starts freshly from the merged head", () => {
	const b = setup([goal("ledger")], 1);
	b.brief("ledger");
	b.ready();
	b.send(hold("queue/1", "ledger"));
	b.send({
		kind: "plan_finding",
		cause: "queue/1",
		text: "Restore decimal input",
		reference: "Current Mandate",
		nodes: ["ledger"],
	});
	const fix = goal("decimal-fix");
	const fixes = [{ cause: "queue/1", item: fix.id }];
	for (const event of [
		{ kind: "plan", items: [fix] },
		{ kind: "plan", items: [{ ...fix, deps: ["ledger"] }], fixes },
		{ kind: "plan", items: [fix], fixes: [{ cause: "queue/2", item: fix.id }] },
	])
		assert.ok("reject" in b.tryEvent(event));
	b.plan([fix], [], fixes);
	b.brief(fix.id, "report");
	b.ready();
	b.publish(fix.id);
	assert.equal(b.worker("ledger")?.paused, true);
	assert.ok(
		!b
			.effects()
			.some((e) =>
				String((e.spec.op as LaneEvent)?.branch).endsWith("/ledger-2"),
			),
	);
	b.merge(fix.id);
	const preparation = b
		.effects()
		.find((e) =>
			String((e.spec.op as LaneEvent)?.branch).endsWith("/ledger-2"),
		);
	assert.equal((preparation?.spec.op as LaneEvent)?.base, tip);
	b.done({ kind: "worktree", base: tip, principles: [] }, preparation?.key);
	assert.match(b.worker("ledger")?.key ?? "", /ledger\/2$/);
	assert.match(
		b.worker("ledger")?.expects[0]?.input?.() ?? "",
		/Restore decimal input/,
	);
});

test("a hold on an already merged node blocks handoff until its disposition", () => {
	const b = setup([goal("done")]);
	b.brief("done");
	b.ready();
	b.publish("done");
	b.merge("done");
	assert.deepEqual(b.coord()?.tools, ["handoff_build"]);
	b.send(hold("queue/1", null, ["ledger"]));
	assert.equal(b.coord(), undefined);
	assert.ok(
		"reject" in b.tryEvent({ kind: "handoff", summary: "Done", risk: "Low" }),
	);
	b.send(release("queue/1"));
	assert.deepEqual(b.coord()?.tools, ["handoff_build"]);
});
