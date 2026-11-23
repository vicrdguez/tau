import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "tau/durable";
import type { LaneEvent } from "../src/kernel/lane.ts";
import { buildLane } from "../src/lanes/build/index.ts";
import type { Mandate } from "../src/lanes/design/public.ts";
import { startBuild } from "./fixtures/build.ts";
import { laneDriver, laneWorld } from "./fixtures/drive.ts";

const { work } = laneWorld();
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
	number: 1,
	mandate: revised,
	causes: ["queue/1"],
	nodes: ["ledger"],
	changes: "ledger: rule, falsifying probe",
	text: "Correct the ledger crossing",
};
function setup(
	items: ReturnType<typeof goal>[],
	max_workers = 2,
	initial = mandate,
	initialReplies: JsonObject[] = [],
) {
	return buildLane.use((lane) => {
		const driver = laneDriver(lane, laneWorld({ options: { max_workers } }));
		const { agents, effects, done } = driver;
		const send = (event: LaneEvent) => driver.send(event).send ?? [];
		const coord = () =>
			agents().find((a) => a.role === "coordinator")?.expects[0];
		const workers = () => agents().filter((a) => a.role === "worker");
		const worker = (item: string) =>
			workers().find((a) => a.key.startsWith(`worker/${item}/`));
		const plan = (
			items: ReturnType<typeof goal>[],
			replies: JsonObject[] = [],
		) => send({ kind: "plan", items, replies });
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
			const routes = send({ kind: "merged", item, head: tip });
			const cleanup = effects().find(
				(e) => (e.spec.op as LaneEvent)?.kind === "remove",
			);
			assert.ok(cleanup);
			done({ kind: "removed" }, cleanup.key);
			return routes;
		};
		const workOn = (id: string, label?: string) => {
			brief(id, label);
			ready();
		};
		const finish = (id: string) => {
			publish(id);
			return merge(id);
		};
		startBuild(driver, initial, {
			root: "/repo",
			commonDir: "/repo/.git",
			base: "main",
			trunk: "trunk",
			baseHead: base,
			trunkHead: base,
		});
		plan(items, initialReplies);
		return {
			send,
			tryEvent: driver.attempt,
			coord,
			worker,
			workers,
			effects,
			done,
			plan,
			brief,
			ready,
			workOn,
			finish,
			publish,
			merge,
			view: driver.view,
			restore: driver.restore,
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
		b.workOn(item, label);
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
	b.workOn("other", "report");
	b.send(release("queue/1"));
	assert.deepEqual(b.effects(), []);
	b.finish("other");
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
	assert.deepEqual(
		b.effects(),
		[],
		"a held preparation cannot be newly claimed",
	);
	b.done({ kind: "worktree", base, principles: [] }, preparing);
	assert.equal(b.worker("affected")?.paused, true);
	b.workOn("other", "report");
	b.send(release("queue/1"));
	assert.equal(b.worker("affected")?.paused, true);
	b.finish("other");
	assert.equal(b.worker("affected")?.paused, false);
	assert.equal(b.worker("affected")?.key, "worker/affected/1");
});

test("a held publication signals Verify exactly once per named cause and only releases that cause", () => {
	const b = setup([goal("item")]);
	b.workOn("item");
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
	b.workOn("item");
	b.finish("item");
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
	b.workOn("affected");
	b.workOn("other", "report");
	b.send(hold("queue/1", null, ["ledger"]));
	assert.deepEqual(b.send(proposal), []);
	assert.match(b.coord()?.input?.() ?? "", /New ledger crossing/);
	assert.match(b.coord()?.input?.() ?? "", /ledger: rule, falsifying probe/);
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
	// Different revision failures: lose a started goal, rewrite its dependencies, or introduce a cycle.
	for (const [items, reason] of [
		[replacement.slice(0, 3), /Keep the started item other/],
		[
			[...replacement.slice(0, 3), goal("other", [], "rewrite history")],
			/Keep the started item other/,
		],
		[
			[...replacement.slice(0, 3), goal("other", ["dependency"])],
			/Keep the dependencies of other/,
		],
		[
			[later, goal("dependency", ["affected"]), ...replacement.slice(2)],
			/cycle/,
		],
	] as const) {
		const result = b.tryEvent({
			kind: "plan",
			items: [...items],
			replies: reply,
		});
		assert.match("reject" in result ? result.reject : "", reason);
	}
	assert.equal(b.worker("affected")?.paused, true);
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
	b.workOn("dependency", "report");
	b.finish("dependency");
	assert.equal(b.worker("affected")?.key, "worker/affected/1");
	assert.match(
		b.worker("affected")?.expects[0]?.input?.() ?? "",
		/New ledger crossing/,
	);
	assert.match(
		b.worker("affected")?.expects[0]?.input?.() ?? "",
		/Correct the ledger crossing/,
	);
	b.finish("affected");
	assert.match(b.coord()?.input?.() ?? "", /Edited later goal/);
});

test("the revision holds affected briefs that the investigator did not name", () => {
	const first = goal("first");
	const report = goal("report");
	const b = setup([first, report]);
	b.workOn(first.id);
	b.workOn(report.id, "report");
	b.send(hold("queue/1", null, ["ledger"]));
	assert.equal(b.worker(report.id)?.paused, false);
	b.send({
		...proposal,
		nodes: ["ledger", "report"],
		mandate: {
			...revised,
			nodes: [
				revised.nodes[0]!,
				{ label: "report", rule: "Report in UTC", probe: "Check time zone" },
			],
		},
	});
	assert.equal(b.worker(report.id)?.paused, true);
});

test("a verified item awaiting merge is a record: require a separate correction depending on it", () => {
	const original = goal("verified");
	const b = setup([original]);
	b.workOn("verified");
	b.publish("verified");
	b.send({ kind: "item_verified", item: "verified" });
	b.send(hold("queue/1", null, ["ledger"]));
	b.send(proposal);
	const correction = goal("correction", ["verified"]);
	const changedRecord = goal("verified", ["setup"]);
	for (const [items, reason] of [
		[[original, goal("correction")], /Add a new correction.*verified/],
		[
			[changedRecord, goal("setup"), correction],
			/Keep the dependencies of verified/,
		],
	] as const) {
		const result = b.tryEvent({
			kind: "plan",
			items: [...items],
			replies: reply,
		});
		assert.match("reject" in result ? result.reject : "", reason);
	}
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
	b.workOn("pending");
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
	b.workOn("dependency", "report");
	b.finish("dependency");
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

test("handoff pairs each note with its local reply and the specific approval after two revisions", () => {
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
	const laterReply = {
		n: 1,
		status: "acted_on",
		reason: "Add a rounding proof",
	};
	b.send({
		...proposal,
		number: 3,
		causes: ["queue/3"],
		mandate: { ...revised, approvalNotes: ["Check precision"] },
	});
	b.plan([item], [laterReply]);
	b.workOn(item.id);
	b.finish(item.id);
	const handoff = b.send({
		kind: "handoff",
		summary: "Ledger done",
		risk: "None",
	})[0]!.event;
	assert.deepEqual(handoff.approvals, [
		{ revision: null, notes: [{ ...firstReply, text: "Check negatives" }] },
		{ revision: 1, notes: [{ ...reply[0], text: "Test tie values" }] },
		{ revision: 3, notes: [{ ...laterReply, text: "Check precision" }] },
	]);
});

test("a stalled worker resumes with both the revision instructions and the owner's new direction", () => {
	const item = goal("ledger");
	const b = setup([item]);
	b.workOn(item.id);
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
	b.workOn("ledger");
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

test("a blocked defect filer waits for all planned items to merge and then starts freshly from the merged head", () => {
	const b = setup([goal("ledger")], 1);
	b.workOn("ledger");
	b.send(hold("queue/1", "ledger"));
	b.send({
		kind: "plan_finding",
		cause: "queue/1",
		text: "Restore decimal input",
		reference: "Current Mandate",
		nodes: ["ledger"],
	});
	b.plan([goal("decimal-fix"), goal("decimal-proof", ["decimal-fix"])]);
	b.workOn("decimal-fix", "report");
	assert.ok(b.finish("decimal-fix").every((m) => m.lane !== "queue"));
	assert.equal(b.worker("ledger")?.paused, true);
	b.workOn("decimal-proof", "report");
	assert.ok(b.finish("decimal-proof").some((m) => m.lane === "queue"));
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

test("a blocked filer linked after a non-blocking defect was planned waits for its remaining items", () => {
	const b = setup([goal("ledger")]);
	b.workOn("ledger");
	b.send({
		kind: "plan_finding",
		cause: "queue/1",
		text: "Fix rounding",
		reference: "Mandate",
		nodes: ["ledger"],
	});
	const fix = goal("fix");
	b.plan([fix]);
	b.workOn(fix.id, "report");
	b.send(hold("queue/2", "ledger"));
	b.send(hold("queue/1", "ledger"));
	b.send(release("queue/2"));
	assert.equal(b.worker("ledger")?.paused, true);
	b.publish(fix.id);
	assert.equal(b.worker("ledger")?.paused, true);
	b.merge(fix.id);
	b.done({ kind: "worktree", base: tip, principles: [] });
	assert.equal(b.worker("ledger")?.key, "worker/ledger/2");
	assert.equal(b.worker("ledger")?.paused, false);
});

test("an appended plan cannot depend on either held filer, directly or through existing dependencies", () => {
	const b = setup(
		[goal("writer"), goal("stats"), goal("reader", ["writer"])],
		2,
	);
	b.workOn("writer");
	b.workOn("stats", "report");
	b.send(hold("queue/1", "writer"));
	b.send(hold("queue/2", "stats"));
	b.send({
		kind: "plan_finding",
		text: "Address framing",
		reference: "Mandate",
		nodes: ["ledger"],
	});
	for (const id of ["stats", "reader"])
		assert.ok(
			"reject" in b.tryEvent({ kind: "plan", items: [goal("fix", [id])] }),
			id,
		);
	b.plan([goal("fix")]);
});

test("a revision cannot introduce a dependency on a filer held by another cause", () => {
	const writer = goal("writer");
	const existing = goal("reader");
	const b = setup([writer, existing]);
	b.workOn(writer.id, "report");
	b.send(hold("queue/2", writer.id));
	b.send(proposal);
	const result = b.tryEvent({
		kind: "plan",
		items: [writer, { ...existing, deps: [writer.id] }],
		replies: reply,
	});
	assert.ok("reject" in result);
	b.plan([writer, existing], reply);
});

test("a revision cannot drop an unmerged item that a defect holds a filer for", () => {
	const writer = goal("writer");
	const b = setup([writer]);
	b.workOn(writer.id, "report");
	b.send(hold("queue/2", writer.id));
	b.send({
		kind: "plan_finding",
		cause: "queue/2",
		text: "Fix framing",
		reference: "Mandate",
		nodes: ["report"],
	});
	const fix = goal("fix");
	const check = goal("check", [fix.id]);
	b.plan([fix, check]);
	b.send(proposal);
	const result = b.tryEvent({
		kind: "plan",
		items: [writer, fix],
		replies: reply,
	});
	assert.match("reject" in result ? result.reject : "", /check/);
	b.plan([writer, fix, check], reply);
});

test("a hold on an already merged node blocks handoff until its disposition", () => {
	const b = setup([goal("done")]);
	b.workOn("done");
	b.finish("done");
	assert.deepEqual(b.coord()?.tools, ["handoff_build"]);
	b.send(hold("queue/1", null, ["ledger"]));
	assert.equal(b.coord(), undefined);
	assert.ok(
		"reject" in b.tryEvent({ kind: "handoff", summary: "Done", risk: "Low" }),
	);
	b.send(release("queue/1"));
	assert.deepEqual(b.coord()?.tools, ["handoff_build"]);
});
