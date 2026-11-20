import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { verify } from "../src/lanes/verify/index.ts";
import { principleInputs } from "../src/principles/index.ts";
import { drive } from "./fixtures/drive.ts";

const world: World = {
	work: 41 as WorkId,
	root: "/repo",
	now: 1,
	view: () => null,
	options: {
		design: "x/y",
		build: "x/y",
		verify: "x/y",
		queue: "x/y",
		base: "main",
		trunk: "trunk",
		max_workers: 3,
	},
};
const repo = {
	root: "/repo",
	commonDir: "/repo/.git",
	base: "main",
	trunk: "trunk",
	baseHead: "base",
	trunkHead: "base",
};
const mandate = {
	reviewed: false,
	delegated: [],
	encodeRequired: false,
	approvalNotes: [],
	intent: "Balance every ledger.",
	nodes: [{ label: "sums", rule: "Sums match", probe: "compare totals" }],
	checks: [{ id: "totals", argv: ["run", "proof"], timeoutMs: 10 }],
	protectedPaths: [],
};
const rulings = [
	{
		principles: [],
		what: "low ruling",
		why: "easy",
		rank: 1,
		cost: "small",
		follows: "sums",
	},
	{
		what: "high ruling",
		principles: ["explain-the-number"],
		why: "hard",
		rank: 5,
		cost: "large",
		follows: "intent",
	},
];
const block = (thread: string) => ({
	thread,
	ground: "failing_run",
	evidence: "negative balance",
});
function flow() {
	const running = new Set<string>();
	const facts = { ...world, runningEffect: (key: string) => running.has(key) };
	let state = verify.state.initial();
	const apply = (event: LaneEvent) => {
		const result = drive(verify, state, event, facts);
		assert.ok("state" in result, JSON.stringify(result));
		state = result.state;
		return result;
	};
	const effects = () => verify.effects(state, world);
	const effect = (kind: string) => {
		const d = effects().find(
			(d) => d.spec.kind === kind || (d.spec.op as LaneEvent)?.kind === kind,
		);
		assert.ok(d, `expected ${kind}: ${JSON.stringify(effects())}`);
		return { key: d.key, op: (d.spec.op ?? d.spec) as LaneEvent };
	};
	const done = (kind: string, result: LaneEvent) =>
		apply({ kind: "effect_done", key: effect(kind).key, result });
	const agents = () =>
		verify.agents(state, world).filter((a) => a.expects.length > 0);
	const agent = (role = "verifier") => {
		const a = agents().find((a) => a.role === role);
		assert.ok(a, `expected ${role}`);
		return a;
	};
	const call = (fields: LaneEvent, role = "verifier") =>
		apply({ ...fields, agent: agent(role).key });
	const publish = (
		sha = "one",
		addresses: string[] = [],
		item = "bug",
		head = "base",
		extra: Record<string, LaneEvent[string]> = {},
	) =>
		apply({
			kind: "published",
			sha,
			addresses,
			item,
			head,
			base: "worker-base",
			itemKind: "build",
			paths: ["ledger/amounts.ts"],
			protectedChanges: [],
			allowed: false,
			trunk: null,
			mandate,
			...extra,
			repo,
			rulings,
			brief: "repair the balance\n\nWorker report:\nNo account loses a cent.",
		});
	const checkout = () =>
		done("checkout", { kind: "checkout", playbook: "project oracle" });
	const clean = () => {
		while (effects().some((d) => (d.spec.op as LaneEvent)?.kind === "remove"))
			done("remove", { kind: "removed" });
	};
	const fail = (thread = "totals") =>
		call({
			kind: "verdict",
			outcome: "fail",
			text: "proof failed",
			blocks: [block(thread)],
			notes: [],
		});
	const pass = () =>
		call({
			kind: "verdict",
			outcome: "pass",
			text: "totals now balance",
			blocks: [],
			notes: ["monitor latency"],
		});
	const merged = () => {
		publish();
		checkout();
		pass();
		clean();
		done("merge_item", { kind: "merged", sha: "merged", checks: [] });
		clean();
	};
	const handoff = () =>
		apply({
			kind: "handoff",
			repo,
			head: "merged",
			base: "base",
			mandate,
			rulings,
			summary: "fixed totals",
			risk: "low volume only",
		});
	const full = () => {
		merged();
		handoff();
		checkout();
		pass();
		return done("remove", { kind: "removed" });
	};
	const take = (trunk = "base") => {
		apply({ kind: "slot_granted" });
		done("read_repo", { kind: "repo", repo: { ...repo, trunkHead: trunk } });
		return effect("take_trunk");
	};
	const prepare = (trunk = "base") => {
		take(trunk);
		done("take_trunk", {
			kind: "combined",
			sha: "combined",
			trunk,
			checks: [],
		});
		clean();
		return effect("prepare_landing");
	};
	const prepared = (trunk = "base") => {
		full();
		prepare(trunk);
		done("prepare_landing", { kind: "prepared", sha: "prepared" });
	};
	const asks = () => verify.asks(state, world);
	return {
		running,
		state: () => state,
		agents,
		agent,
		call,
		apply,
		effects,
		effect,
		done,
		publish,
		checkout,
		clean,
		fail,
		pass,
		merged,
		handoff,
		full,
		take,
		prepare,
		prepared,
		asks,
	};
}
const resume = (file: LaneEvent) => ({
	kind: "resume",
	cause: file.cause!,
	item: file.item!,
	direction: "test the premise",
	evidence: file.evidence!,
});
test("Verify opens only the published checkout, renders the proof, brief, rulings and project playbook; inconsistent verdicts are refused", () => {
	const x = flow();
	x.publish();
	const op = x.effect("checkout").op;
	assert.equal(op.sha, "one");
	assert.equal(x.agents().length, 0);
	x.checkout();
	const a = x.agent();
	assert.equal(a.cwd, op.path);
	const input = a.expects[0]!.input!();
	for (const expected of [
		"one",
		"Diff base: worker-base",
		"project oracle",
		"repair the balance",
		"No account loses a cent.",
		"high ruling",
		"explain-the-number",
		"compare totals",
		"totals",
	])
		assert.ok(input.includes(expected), expected);
	for (const [outcome, blocks] of [
		["fail", []],
		["pass", [block("a")]],
		["fail", [block("a"), block("a")]],
		["fail", [{ ...block("a"), ground: "" }]],
		["fail", [{ ...block("a"), evidence: " " }]],
	] as const) {
		assert.ok(
			"reject" in
				verify.reduce(
					x.state(),
					{
						kind: "verdict",
						agent: a.key,
						text: "check",
						outcome,
						blocks: [...blocks],
						notes: [],
					},
					world,
				),
		);
	}
});
test("surviving two addressed fixes opens a fresh diagnosis, then a finding, then directed rework; resets the count", () => {
	const x = flow();
	x.publish();
	x.checkout();
	const first = x.fail();
	assert.deepEqual(first.send?.[0]?.event.threads, ["totals"]);
	for (let i = 0; i < 2; i++) {
		x.publish(`fix${i}`, ["totals"]);
		x.clean();
		x.checkout();
		const r =
			i === 0
				? x.fail()
				: x.call({
						kind: "verdict",
						outcome: "fail",
						text: "two independent problems",
						blocks: [block("new-defect"), block("totals")],
						notes: [],
					});
		if (i === 0) assert.equal(r.send?.[0]?.event.kind, "rework");
		else assert.ok(!r.send?.length);
	}
	const a = x.agent("diagnoser");
	const stalled = x.apply({
		kind: "agent_stalled",
		agent: a.key,
		tokens: [a.expects[0]!.token],
		cause: "stopped",
		lastWords: "checking that premise",
	});
	const stall = stalled.send?.[0]?.event;
	assert.ok(stall);
	x.apply({ kind: "reset_counts", item: "bug" });
	x.apply({ ...resume(stall), direction: "Diagnoser only: inspect floats" });
	const diagnosis = x.agent("diagnoser");
	const exp = diagnosis.expects[0]!;
	const request = principleInputs.render(
		{ role: diagnosis.role, cwd: diagnosis.cwd!, situation: exp.situation },
		exp.input!(),
	).text;
	assert.match(request, /# Fix Root Causes/);
	assert.match(request, /# Attack the Premise/);
	assert.doesNotMatch(request, /description:/);
	assert.ok(request.includes("[Build the Lever](build-the-lever.md)"));
	assert.match(request, /negative balance/);
	assert.match(request, /Diagnoser only: inspect floats/);
	assert.match(request, /Threads that survived two claimed fixes: totals/);
	const r = x.call(
		{
			kind: "diagnosis",
			premise: "float is exact",
			test: "add tenths",
			result: "not exact",
		},
		"diagnoser",
	);
	const file = r.send?.find((m) => m.lane === "queue")?.event;
	assert.ok(file);
	assert.equal(file.item, "bug");
	assert.match(String(file.evidence), /Two claimed fixes failed on totals/);
	assert.match(String(file.evidence), /not exact/);
	assert.equal(x.agents().length, 0);
	const back = x.apply(resume(file));
	assert.match(String(back.send?.[0]?.event.direction), /test the premise/);
	assert.doesNotMatch(
		String(back.send?.[0]?.event.evidence),
		/test the premise/,
	);
	assert.match(String(back.send?.[0]?.event.evidence), /not exact/);
	assert.doesNotMatch(JSON.stringify(back.send), /Diagnoser only/);
	x.apply({ kind: "reset_counts", item: "bug" });
	x.publish("fix3", ["totals"]);
	x.clean();
	x.checkout();
	assert.equal(x.fail().send?.[0]?.event.kind, "rework");
	x.publish("finally-fixed");
	x.clean();
	x.checkout();
	x.pass();
	x.clean();
	x.done("merge_item", { kind: "merged", sha: "merged", checks: [] });
	x.clean();
	x.handoff();
	x.checkout();
	x.pass();
	x.clean();
	x.prepare();
	x.done("prepare_landing", { kind: "unchanged", sha: "base" });
	assert.match(x.asks()[0]!.basis, /Two claimed fixes failed on totals/);
	assert.match(x.asks()[0]!.basis, /float is exact/);
	assert.match(x.asks()[0]!.basis, /not exact/);
});
test("an item verifier binds policy for the published fences, without leaking them into full-set review", () => {
	const x = flow();
	x.publish();
	x.checkout();
	assert.deepEqual(x.agent().expects[0]!.paths, ["ledger/amounts.ts"]);
	x.pass();
	x.clean();
	x.done("merge_item", { kind: "merged", sha: "merged", checks: [] });
	x.clean();
	x.handoff();
	x.checkout();
	assert.deepEqual(x.agent().expects[0]!.paths ?? [], []);
});
test("unaddressed reappearances and unrelated blocks never spend a fix; superseding a failed checkout removes its original target", () => {
	const x = flow();
	for (const [i, thread] of ["A", "A", "A", "B", "C", "D"].entries()) {
		x.publish(`sha${i}`);
		if (i) {
			assert.equal(
				(x.effect("remove").op.target as LaneEvent).sha,
				`sha${i - 1}`,
			);
			x.clean();
		}
		x.checkout();
		assert.equal(x.fail(thread).send?.[0]?.event.kind, "rework");
	}
});
test("a superseded checkout obstruction holds the next review; a pass cleanup failure prevents a merge until the removal succeeds", () => {
	const x = flow();
	x.publish();
	x.checkout();
	x.fail();
	x.publish("repair");
	const f = x.done("remove", { kind: "occupied", path: "/private" }).send?.[0]
		?.event;
	assert.ok(f);
	assert.deepEqual(x.effects(), []);
	x.apply(resume(f));
	x.clean();
	x.checkout();
	x.pass();
	const key = x.effect("remove").key;
	const r = x.apply({
		kind: "effect_failed",
		key,
		error: "could not clean checkout",
	});
	const held = r.send?.[0]?.event;
	assert.ok(held);
	assert.equal(held.item, "bug");
	assert.deepEqual(x.effects(), []);
	x.apply(resume(held));
	x.clean();
	assert.equal(x.effect("merge_item").op.item, "repair");
});
test("integration checkout must be removed before the full review; full checkout removal precedes taking the slot", () => {
	const x = flow();
	x.publish();
	x.checkout();
	x.pass();
	x.clean();
	x.done("merge_item", { kind: "merged", sha: "merged", checks: [] });
	x.handoff();
	assert.deepEqual(
		x.effects().map((j) => (j.spec.op as LaneEvent)?.kind),
		["remove"],
	);
	x.clean();
	x.checkout();
	const pass = x.pass();
	assert.ok(!pass.send?.some((m) => m.event.kind === "take_slot"));
	const held = x.done("remove", { kind: "occupied", path: "/private" })
		.send?.[0]?.event;
	assert.ok(held);
	assert.equal(x.asks().length, 0);
	x.apply(resume(held));
	assert.ok(
		x
			.done("remove", { kind: "removed" })
			.send?.some((m) => m.event.kind === "take_slot"),
	);
});
test("full threads addressed by a correction still count after a separate item rework before merge", () => {
	const x = flow();
	x.merged();
	x.handoff();
	x.checkout();
	x.fail("cross-book");
	for (const n of [1, 2]) {
		const item = `correction${n}`;
		x.publish(`fix${n}`, ["cross-book"], item, "merged");
		x.clean();
		x.checkout();
		x.fail("local");
		x.publish(`retry${n}`, ["local"], item, "merged");
		x.clean();
		x.checkout();
		x.pass();
		x.clean();
		x.done("merge_item", { kind: "merged", sha: "merged", checks: [] });
		x.clean();
		x.handoff();
		x.checkout();
		x.fail("cross-book");
	}
	assert.ok(x.agent("diagnoser").expects.length);
});
test("item merges serialize against successive build heads with Mandate checks, and pass cleans up the verifier", () => {
	const x = flow();
	x.publish();
	const checked = x.effect("checkout").op;
	x.checkout();
	x.pass();
	assert.deepEqual(x.effect("remove").op.target, checked);
	x.clean();
	const op = x.effect("merge_item").op;
	assert.equal(op.expected, "base");
	assert.deepEqual(op.checks, mandate.checks);
	x.publish("two", [], "other");
	x.checkout();
	x.pass();
	x.clean();
	assert.equal(
		x.effects().filter((d) => (d.spec.op as LaneEvent)?.kind === "merge_item")
			.length,
		1,
	);
	const merged = x.done("merge_item", {
		kind: "merged",
		sha: "first-merged",
		checks: [],
	});
	assert.deepEqual(merged.send?.find((m) => m.lane === "build")?.event, {
		kind: "merged",
		item: "bug",
		head: "first-merged",
	});
	x.clean();
	assert.equal(x.effect("merge_item").op.expected, "first-merged");
});
for (const failure of [
	{ kind: "conflict", paths: ["balance.ts"], against: "other" },
	{
		kind: "checks_failed",
		sha: "candidate",
		checks: [{ id: "totals", code: 1, tail: "balance.ts" }],
	},
] as LaneEvent[]) {
	for (const phase of ["merge_item", "take_trunk"])
		test(`${failure.kind} during ${phase} is integration work, not a verdict; release slot and clean up integration`, () => {
			const x = flow();
			if (phase === "merge_item") {
				x.publish();
				x.checkout();
				x.pass();
				x.clean();
			} else {
				x.full();
				x.take();
			}
			const op = x.effect(phase).op;
			const r = x.done(phase, failure);
			const event = r.send?.find((m) => m.lane === "build")?.event;
			assert.equal(event?.kind, "integration");
			if (phase === "take_trunk") assert.equal(event?.inheritedTrunk, "base");
			assert.equal(x.state().verdicts.length, phase === "take_trunk" ? 2 : 1);
			assert.match(String(event?.evidence), /balance.ts/);
			assert.equal(
				r.send?.some((m) => m.event.kind === "release_slot"),
				phase === "take_trunk",
			);
			assert.equal((x.effect("remove").op.target as LaneEvent).key, op.key);
		});
}
test("full-set pass asks for a slot before reading live trunk and pins the prepared target in the CAS", () => {
	const x = flow();
	const r = x.full();
	assert.equal(r.send?.[0]?.lane, "trunk");
	assert.equal(r.send?.[0]?.event.kind, "take_slot");
	assert.equal(x.effects().length, 0);
	const { op } = x.prepare();
	x.done("prepare_landing", { kind: "prepared", sha: "prepared" });
	const land = x.effect("land").op;
	assert.deepEqual(land, {
		...(op.landing as object),
		kind: "land",
		target: "prepared",
	});
	assert.equal(x.agents().length, 0);
});
test("a moved trunk gets a verifier on the exact prepared SHA before CAS; either full-set failure routes back to Build", () => {
	const x = flow();
	x.prepared("other-trunk");
	assert.equal(x.effect("checkout").op.sha, "prepared");
	x.checkout();
	assert.ok(
		!x.effects().some((d) => (d.spec.op as LaneEvent)?.kind === "land"),
	);
	const r = x.fail();
	assert.equal(r.send?.find((m) => m.lane === "build")?.event.head, "combined");
	assert.equal(r.send?.find((m) => m.lane === "build")?.event.item, "full");
	assert.ok(r.send?.some((m) => m.event.kind === "release_slot"));
	const y = flow();
	y.prepared("other-trunk");
	y.checkout();
	y.pass();
	y.clean();
	assert.equal(y.effect("land").op.target, "prepared");
	const z = flow();
	z.merged();
	z.handoff();
	z.checkout();
	assert.equal(
		z.fail().send?.find((m) => m.lane === "build")?.event.kind,
		"rework",
	);
});
test("no-change preparation releases the slot without CAS and hands over the unchanged commit", () => {
	const x = flow();
	x.full();
	x.prepare();
	const r = x.done("prepare_landing", { kind: "unchanged", sha: "base" });
	assert.ok(r.send?.some((m) => m.event.kind === "release_slot"));
	assert.equal(x.effects().length, 0);
	assert.match(x.asks()[0]!.basis, /unchanged|no change/i);
});
for (const result of [
	{ kind: "occupied", path: "foreign-path" },
	{ kind: "moved", actual: "foreign-ref" },
])
	test(`${result.kind} holds operation until directed retry, never adopts foreign checkout or ref`, () => {
		const x = flow();
		x.publish();
		const op = x.effect("checkout");
		const r = x.done("checkout", result as LaneEvent);
		const file = r.send?.[0]?.event;
		assert.equal(file?.kind, "file");
		assert.match(String(file.evidence), /foreign/);
		assert.ok(!x.effects().length);
		x.apply(resume(file));
		const retried = x.effect("checkout");
		assert.notEqual(retried.key, op.key);
		assert.equal(retried.op.sha, "one");
		x.checkout();
		assert.match(x.agent().expects[0]!.input!(), /test the premise/);
	});
test("owner direction on a merge retry reaches the worker on conflict or the full verifier on success", () => {
	for (const conflict of [false, true]) {
		const x = flow();
		x.publish();
		x.checkout();
		x.pass();
		x.clean();
		const filing = x.apply({
			kind: "effect_failed",
			key: x.effect("merge_item").key,
			error: "lost integration checkout",
		}).send?.[0]?.event;
		assert.ok(filing);
		x.apply(resume(filing));
		let next: string;
		if (conflict) {
			const sent = x.done("merge_item", {
				kind: "conflict",
				paths: ["book"],
				against: "previous",
			});
			const update = sent.send?.find((m) => m.lane === "build")?.event;
			assert.doesNotMatch(String(update?.evidence), /test the premise/);
			next = String(update?.direction);
		} else {
			x.done("merge_item", { kind: "merged", sha: "merged", checks: [] });
			x.clean();
			x.handoff();
			x.checkout();
			next = x.agent().expects[0]!.input!();
		}
		assert.match(next, /test the premise/);
		assert.match(next, /lost integration checkout/);
	}
});
test("exhausted CAS holds its exact plan for safe retry even if the write already succeeded", () => {
	const x = flow();
	x.prepared();
	const plan = x.effect("land");
	const r = x.apply({
		kind: "effect_failed",
		key: plan.key,
		error: "lost git reply",
	});
	const file = r.send?.find((m) => m.lane === "queue")?.event;
	assert.ok(file);
	assert.match(String(file.evidence), /lost git reply/);
	assert.match(String(file.resume), /same pinned/i);
	x.apply({ ...resume(file), kind: "finding_direction", lane: "verify" });
	x.apply(resume(file));
	const retry = x.effect("land");
	assert.deepEqual(retry.op, plan.op);
	assert.notEqual(retry.key, plan.key);
	x.done("land", { kind: "landed", sha: "prepared" });
	assert.equal(x.asks().length, 1);
	assert.match(x.asks()[0]!.basis, /lost git reply/);
	assert.match(x.asks()[0]!.basis, /test the premise/);
});
for (const cause of ["failed", "stopped", "unfulfilled"])
	test(`${cause} verifier resumes only on a fresh token with owner direction`, () => {
		const x = flow();
		x.publish();
		x.checkout();
		const a = x.agent();
		const r = x.apply({
			kind: "agent_stalled",
			agent: a.key,
			tokens: [a.expects[0]!.token],
			cause,
			lastWords: "compare failed",
		});
		const f = r.send?.[0]?.event;
		assert.ok(f);
		assert.match(String(f.evidence), /compare failed/);
		assert.equal(x.agents().length, 0);
		x.apply(resume(f));
		const b = x.agent();
		assert.notEqual(b.expects[0]!.token, a.expects[0]!.token);
		assert.match(b.expects[0]!.input!(), /test the premise/);
	});
test("cancel withdraws waiting slot and ignores a late grant; an already running landing finishes under the slot and is reported", () => {
	const x = flow();
	x.full();
	assert.ok(
		x
			.apply({ kind: "cancel" })
			.send?.some((m) => m.event.kind === "release_slot"),
	);
	x.apply({ kind: "slot_granted" });
	assert.equal(x.effects().length, 0);
	const y = flow();
	y.prepared();
	const op = y.effect("land");
	y.running.add(op.key);
	assert.ok(
		!y
			.apply({ kind: "cancel" })
			.send?.some((m) => m.event.kind === "release_slot"),
	);
	assert.deepEqual(y.effect("land"), op);
	const r = y.done("land", { kind: "landed", sha: "prepared" });
	assert.match(JSON.stringify(r.notes), /prepared/);
	assert.ok(r.send?.some((m) => m.event.kind === "release_slot"));
	assert.equal(y.asks().length, 0);
});
const change = (path: string) => ({
	path,
	kind: "modified",
	before: "old",
	after: "new",
});
const protectedResult = (path: string) => ({
	kind: "protected",
	sha: "candidate",
	touched: [path],
	protectedChanges: [change(path)],
});
function pendingMerge() {
	const x = flow();
	x.publish("worker", [], "bug", "intervening-merge", {
		protectedChanges: [change("tests/balance")],
		allowed: true,
		trunk: "inherited",
	});
	x.checkout();
	const input = x.agent().expects[0]!.input!();
	assert.match(input, /tests\/balance/);
	assert.match(input, /owner allowed/i);
	x.pass();
	x.clean();
	return x;
}
test("guard the merge before proofs or ref advance; allowing a merge-only change reviews its pinned candidate before retry", () => {
	const x = pendingMerge();
	const merge = x.effect("merge_item");
	assert.deepEqual(merge.op.protection, {
		trunk: "inherited",
		reviewedEncode: false,
		allowedChanges: [change("tests/balance")],
		allowedCandidate: null,
	});
	assert.deepEqual(merge.op.protectedGlobs, mandate.protectedPaths);
	const file = x.done("merge_item", protectedResult("tests/other")).send?.[0]
		?.event;
	assert.ok(file);
	assert.equal(file.allow, true);
	assert.equal(file.goal, mandate.intent);
	assert.deepEqual(x.effects(), []);
	x.apply({ ...resume(file), kind: "allow" });
	assert.equal(x.effect("checkout").op.sha, "candidate");
	x.checkout();
	assert.match(x.agent().expects[0]!.input!(), /tests\/other/);
	assert.match(x.agent().expects[0]!.input!(), /owner allowed/i);
	assert.ok(!x.effects().length);
	x.pass();
	x.clean();
	const retry = x.effect("merge_item");
	assert.notEqual(retry.key, merge.key);
	assert.equal(retry.op.item, "worker");
	assert.equal(retry.op.key, merge.op.key);
	assert.equal(
		(retry.op.protection as LaneEvent).allowedCandidate,
		"candidate",
	);
});
test("policy files cannot be waived at merge even for Encode; resume returns evidence to worker, not a CAS", () => {
	const x = flow();
	x.publish("encoded", [], "bug", "base", {
		itemKind: "encode",
		mandate: { ...mandate, reviewed: true },
	});
	x.checkout();
	x.pass();
	x.clean();
	assert.equal(
		(x.effect("merge_item").op.protection as LaneEvent).reviewedEncode,
		true,
	);
	const f = x.done("merge_item", protectedResult(".keel/policy")).send?.[0]
		?.event;
	assert.ok(f && !f.allow);
	const result = x.apply(resume(f));
	const back = result.send?.find((m) => m.lane === "build")?.event;
	assert.equal(back?.kind, "integration");
	assert.match(String(back?.evidence), /\.keel\/policy/);
	assert.match(String(back?.direction), /test the premise/);
	assert.doesNotMatch(String(back?.evidence), /test the premise/);
	x.clean();
	assert.deepEqual(x.effects(), []);
});
test("full verifier sees the protected files each merge actually changed, distinguishing an owner waiver from an ordinary addition", () => {
	const x = pendingMerge();
	const added = { ...change("tests/new"), kind: "added" };
	x.done("merge_item", {
		kind: "merged",
		sha: "merged",
		checks: [],
		protectedChanges: [change("tests/balance"), added],
	});
	x.clean();
	x.handoff();
	x.checkout();
	const input = x.agent().expects[0]!.input!();
	assert.match(input, /tests\/balance[^\n]*owner allowed/i);
	assert.match(input, /tests\/new[^\n]*no owner waiver/i);
});
test("a second stopped turn receives the new direction, not a replay of instructions already delivered", () => {
	const x = flow();
	x.publish("one", [], "bug", "base", {
		allowed: true,
		protectedChanges: [change("tests/check")],
		direction: "Waiver instruction: inspect this test",
	});
	x.checkout();
	assert.match(x.agent().expects[0]!.input!(), /Waiver instruction/);
	function stop() {
		const a = x.agent();
		const f = x.apply({
			kind: "agent_stalled",
			agent: a.key,
			tokens: [a.expects[0]!.token],
			cause: "stopped",
			lastWords: "paused",
		}).send?.[0]?.event;
		assert.ok(f);
		return f;
	}
	x.apply({ ...resume(stop()), direction: "inspect rounding" });
	assert.match(x.agent().expects[0]!.input!(), /inspect rounding/);
	assert.doesNotMatch(x.agent().expects[0]!.input!(), /Waiver instruction/);
	x.apply({ ...resume(stop()), direction: "inspect carries" });
	const next = x.agent().expects[0]!.input!();
	assert.match(next, /inspect carries/);
	assert.doesNotMatch(next, /inspect rounding/);
});
test("all finding directions survive handoff, including answers before the first publication", () => {
	const x = flow();
	for (const lane of ["design", "build", "verify"])
		x.apply({
			kind: "finding_direction",
			lane,
			item: null,
			cause: lane + "/1",
			evidence: "hold in " + lane,
			direction: "follow " + lane,
		});
	x.prepared();
	x.done("land", { kind: "landed", sha: "prepared" });
	for (const lane of ["design", "build", "verify"])
		assert.ok(x.asks()[0]!.basis.includes("follow " + lane));
});
test("a stopped verifier has one finding, and neither its stale stop nor its fulfilled token reopens it", () => {
	const x = flow();
	x.publish();
	x.checkout();
	const a = x.agent(),
		stop = {
			kind: "agent_stalled",
			agent: a.key,
			tokens: [a.expects[0]!.token],
			cause: "stopped",
			lastWords: "checking",
		};
	const f = x.apply(stop).send?.[0]?.event;
	assert.ok(f);
	assert.ok(!x.apply(stop).send?.length);
	x.apply(resume(f));
	assert.ok(!x.apply(stop).send?.length);
	const active = x.agent();
	x.pass();
	assert.ok(
		!x.apply({ ...stop, tokens: [active.expects[0]!.token] }).send?.length,
	);
});
test("cancel withdraws an unclaimed CAS without landing; all cleanup replies exactly once", () => {
	const x = flow();
	x.prepared();
	const r = x.apply({ kind: "cancel" });
	assert.ok(r.send?.some((m) => m.event.kind === "release_slot"));
	assert.deepEqual(x.effects(), []);
	assert.deepEqual(r.send?.find((m) => m.lane === "design")?.event, {
		kind: "cleanup_finished",
		lane: "verify",
		kept: [],
	});
	assert.ok(!x.apply({ kind: "cancel" }).send?.length);
});
for (const mode of ["running", "held", "unclaimed"]) {
	test(
		"cancel at " +
			mode +
			" integration orders disposal after the last possible writer and reports kept paths",
		() => {
			const x = flow();
			x.publish();
			x.checkout();
			x.pass();
			x.clean();
			const merge = x.effect("merge_item");
			if (mode === "held")
				x.apply({
					kind: "effect_failed",
					key: merge.key,
					error: "interrupted proof",
				});
			if (mode === "running") x.running.add(merge.key);
			const r = x.apply({ kind: "cancel" });
			if (mode === "running") {
				assert.ok(
					!x.effects().some((d) => (d.spec.op as LaneEvent).kind === "remove"),
				);
				assert.ok(!r.send?.some((m) => m.event.kind === "cleanup_finished"));
				x.apply({
					kind: "effect_failed",
					key: merge.key,
					error: "interrupted proof",
				});
			}
			if (mode === "unclaimed") {
				assert.ok(
					!x
						.effects()
						.some((d) => (d.spec.op as LaneEvent).kind === "merge_item"),
				);
			}
			const removal = x.effect("remove");
			assert.equal((removal.op.target as LaneEvent).path, merge.op.integration);
			const cleaned = x.apply({
				kind: "effect_failed",
				key: removal.key,
				error: "cannot prove ownership",
			});
			const report = cleaned.send?.find(
				(m) => m.event.kind === "cleanup_finished",
			)?.event;
			assert.ok(report);
			assert.ok(
				JSON.stringify(report.kept).includes(String(merge.op.integration)),
			);
			assert.ok(JSON.stringify(report.kept).includes("cannot prove ownership"));
			assert.equal(x.effects().length, 0);
		},
	);
}
test("a cleanup already held on cancel is retried; a running checkout settles before removal even after failure", () => {
	const x = flow();
	x.publish();
	const make = x.effect("checkout");
	x.running.add(make.key);
	x.apply({ kind: "cancel" });
	assert.ok(
		!x.effects().some((d) => (d.spec.op as LaneEvent).kind === "remove"),
	);
	x.apply({
		kind: "effect_failed",
		key: make.key,
		error: "partial registration",
	});
	assert.deepEqual(x.effect("remove").op.target, make.op);
	const y = flow();
	y.publish();
	y.checkout();
	y.pass();
	const old = y.effect("remove");
	y.done("remove", { kind: "occupied", path: "obstruction" });
	y.apply({ kind: "cancel" });
	assert.notEqual(y.effect("remove").key, old.key);
	assert.deepEqual(y.effect("remove").op.target, old.op.target);
});
for (const choice of ["reject", "accept"])
	test(`hand-over releases slot and lists all evidence in cost order; ${choice} closes without reverting trunk`, () => {
		const x = flow();
		x.prepared();
		const r = x.done("land", { kind: "landed", sha: "prepared" });
		assert.ok(r.send?.some((m) => m.event.kind === "release_slot"));
		const [a] = x.asks();
		assert.ok(a);
		for (const part of [
			"prepared",
			"Balance every ledger.",
			"totals now balance",
			"monitor latency",
			"low volume only",
			"high ruling",
			"explain-the-number",
			"small",
			"large",
		])
			assert.ok(a.basis.includes(part), part);
		assert.ok(a.basis.indexOf("high ruling") < a.basis.indexOf("low ruling"));
		const answer = {
			kind: "answered",
			subject: a.subject,
			choice,
			decision: "answer#1",
			annotations: [{ n: 1, text: "missing overflow probe" }],
		};
		const closed = x.apply(answer);
		assert.deepEqual(closed.send?.map((m) => [m.lane, m.event.kind]).sort(), [
			["build", "closed"],
			["design", "closed"],
		]);
		assert.equal(x.asks().length, 0);
		if (choice === "reject")
			assert.match(JSON.stringify(x.state()), /missing overflow probe/);
		assert.ok(!x.apply(answer).send?.length);
	});
