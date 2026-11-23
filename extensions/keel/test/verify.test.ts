import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import { verify } from "../src/lanes/verify/index.ts";
import { principleInputs } from "../src/principles/index.ts";
import { drive, laneDriver, laneWorld } from "./fixtures/drive.ts";

const world = laneWorld({ work: 41 as WorkId, options: { max_workers: 3 } });
const repo = {
	root: "/repo",
	commonDir: "/repo/.git",
	base: "main",
	trunk: "trunk",
	baseHead: "base",
	trunkHead: "base",
};
const mandate = {
	delegated: [],
	encodeRequired: false,
	approvalNotes: [],
	intent: "Balance every ledger.",
	considerations: null,
	nodes: [{ label: "sums", rule: "Sums match", probe: "compare totals" }],
	checks: [{ id: "totals", argv: ["run", "proof"], timeoutMs: 10 }],
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
function flow(view = world.view) {
	const running = new Set<string>();
	const facts = {
		...world,
		view,
		runningEffect: (key: string) => running.has(key),
	};
	const driver = laneDriver(verify, facts);
	const { send: apply, effects } = driver;
	const effect = (kind: string) => {
		const d = effects().find(
			(d) => d.spec.kind === kind || (d.spec.op as LaneEvent)?.kind === kind,
		);
		assert.ok(d, `expected ${kind}: ${JSON.stringify(effects())}`);
		return { key: d.key, op: (d.spec.op ?? d.spec) as LaneEvent };
	};
	const done = (kind: string, result: LaneEvent) =>
		driver.done(result, effect(kind).key);
	const agents = () => driver.agents().filter((a) => a.expects.length > 0);
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
			paths: ["ledger/amounts.ts"],
			changedPolicyFiles: [],
			mandate,
			...extra,
			repo,
			rulings,
			brief: "repair the balance\n\nWorker report:\nNo account loses a cent.",
		});
	const checkout = () =>
		done("checkout", { kind: "checkout", playbook: "project oracle" });

	const review = (...args: Parameters<typeof publish>) => {
		publish(...args);
		checkout();
	};
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
	const mergedBeforeConflict = () => {
		review();
		pass();
		clean();
	};
	const merged = () => {
		mergedBeforeConflict();
		done("merge_item", { kind: "merged", sha: "merged", checks: [] });
		clean();
	};
	const handoff = (extra: Record<string, LaneEvent[string]> = {}) =>
		apply({
			kind: "handoff",
			repo,
			head: "merged",
			base: "base",
			mandate,
			rulings,
			summary: "fixed totals",
			risk: "low volume only",
			approvals: [],
			...extra,
		});
	const full = (extra?: Record<string, LaneEvent[string]>) => {
		merged();
		handoff(extra);
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
	const land = (extra?: Record<string, LaneEvent[string]>) => {
		full(extra);
		prepare();
		done("prepare_landing", { kind: "prepared", sha: "prepared" });
		return done("land", { kind: "landed", sha: "prepared" });
	};
	return {
		land,
		running,
		state: driver.state,
		attempt: driver.attempt,
		agents,
		agent,
		call,
		apply,
		effects,
		effect,
		done,
		publish,
		checkout,
		review,
		clean,
		fail,
		pass,
		merged,
		mergedBeforeConflict,
		handoff,
		full,
		take,
		prepare,
		prepared,
		asks: driver.asks,
	};
}
const findingHold = (cause: string, item = "bug") => ({
	kind: "queue_hold",
	item,
	cause,
	evidence: "The rounding boundary may be wrong.",
});
const revised = (items: string[] = ["bug"]) => ({
	kind: "mandate_revised",
	items,
	mandate: {
		...mandate,
		checks: [{ id: "rounding", argv: ["probe", "rounding"], timeoutMs: 13 }],
	},
	evidence: "Use the revised ledger boundary.",
});

test("hand-over rejection requires an explanation, then files each nonblank annotation with the landed commit and evidence", () => {
	const revisionSummary = "- Revision 1: sums (falsifying probe)";
	const x = flow((lane) =>
		lane === "design"
			? {
					ownerReviewed: false,
					reference: "Approved ledger contract §2",
					revisionSummary,
				}
			: null,
	);
	x.land({
		mandate: {
			...mandate,
			intent: "Balance every ledger.\n\nDone when: Both sums match.",
		},
		approvals: [
			{
				revision: null,
				notes: [
					{
						n: 1,
						text: "Cover zero.",
						status: "acted_on",
						reason: "Added the check.",
					},
				],
			},
			{
				revision: 1,
				notes: [
					{
						n: 1,
						text: "Consider another oracle.",
						status: "considered",
						reason: "Already covered.",
					},
				],
			},
		],
	});
	const [open] = x.asks();
	const blank = x.apply({
		kind: "answered",
		subject: open!.subject,
		choice: "reject",
		annotations: [{ n: 1, text: " " }],
	});
	assert.deepEqual(blank.send, []);
	assert.equal(x.asks()[0]?.subject, open?.subject);
	assert.match(open!.title, /Balance every ledger/);
	assert.doesNotMatch(open!.title, /\n|Done when:/);
	assert.match(
		open!.basis,
		/Mandate approval\n\n1\. Cover zero\.\n\s+acted_on: Added the check\./,
	);
	assert.match(
		open!.basis,
		/Revision 1 approval\n\n1\. Consider another oracle\.\n\s+considered: Already covered\./,
	);
	assert.ok(open!.basis.includes(revisionSummary));
	function expectMandate(document: string) {
		const bound =
			document.match(/## Bound Mandate\n([\s\S]*?)\nRulings,/)?.[1] ?? "";
		assert.match(bound, /Reference: Approved ledger contract §2/);
		assert.match(bound, /Done when: Both sums match/);
		assert.match(
			bound,
			/sums: Rule\s+Sums match\s+Falsifying probe: compare totals/,
		);
		assert.match(
			bound,
			/totals: Proof[\s\S]*\["run","proof"\][\s\S]*Timeout: 10 ms/,
		);
	}
	expectMandate(open!.basis);
	const result = x.apply({
		kind: "answered",
		subject: open!.subject,
		choice: "reject",
		annotations: [
			{ n: 1, text: "Check the lower bound." },
			{ n: 2, text: " " },
			{ n: 3, text: "Check the lower bound." },
		],
	});
	const filings = result.send!.filter((m) => m.lane === "queue");
	assert.deepEqual(
		filings.map(({ work, event }) => [
			work,
			event.kind,
			event.source,
			event.sha,
			event.text,
		]),
		[
			[null, "intake", "owner", "prepared", "Check the lower bound."],
			[null, "intake", "owner", "prepared", "Check the lower bound."],
		],
	);
	assert.deepEqual(open!.choices, ["accept", "reject"]);
	assert.match(open!.basis, /Accept the result on trunk, or reject it/);
	assert.match(open!.basis, /filed as a finding/);
	assert.notEqual(filings[0]?.event.report, filings[1]?.event.report);
	expectMandate(String(filings[0]?.event.report));
	for (const { event } of filings) {
		assert.equal(event.blocking, false);
		assert.match(String(event.report), /Balance every ledger/);
		assert.doesNotMatch(String(event.report), /Accept the result|Promotion to/);
	}
	assert.deepEqual(
		result.send
			?.filter((m) => m.lane !== "queue")
			.map((m) => [m.lane, m.event.kind])
			.sort(),
		[
			["build", "closed"],
			["design", "closed"],
		],
	);
	assert.deepEqual(x.effects(), []);
	assert.deepEqual(x.asks(), []);
});

test("an unfollowed principle must name a real block to file a clarification independently of rework", () => {
	const x = flow();
	x.review();
	const verdict = {
		kind: "verdict",
		agent: x.agent().key,
		outcome: "fail",
		text: "One rounding boundary is missing.",
		notes: [],
		blocks: [
			{
				thread: "half-cent",
				ground: "mandate_violation",
				evidence: "A half-cent is rounded twice.",
			},
		],
	};
	const name = "project/round-once";
	const refused = x.attempt({
		...verdict,
		principlesUnfollowed: [{ name, thread: "absent" }],
	});
	assert.match(
		"reject" in refused ? refused.reject : "",
		/existing block thread/,
	);
	const result = x.apply({
		...verdict,
		principlesUnfollowed: [{ name, thread: "half-cent" }],
	});
	assert.ok(result.send?.some((m) => m.event.kind === "rework"));
	const proposal = result.send?.find((m) => m.event.kind === "intake");
	assert.equal(proposal?.event.blocking, false);
	assert.equal(proposal?.event.principle, true);
	assert.match(String(proposal?.event.text), /project\/round-once/);
	assert.match(String(proposal?.event.report), /A half-cent is rounded twice/);
});

test("a classified item hold gates verifier tools and keeps siblings running until the last cause drops", () => {
	const x = flow();
	x.review();
	const first = x.agent();
	x.review("sibling-head", [], "sibling");
	x.apply(findingHold("first"));
	x.apply(findingHold("second"));
	assert.deepEqual(
		x.agents().map((a) => a.key),
		["verify/sibling"],
	);
	assert.ok(
		"reject" in
			verify.reduce(
				x.state(),
				{
					kind: "verdict",
					agent: first.key,
					outcome: "pass",
					text: "old evidence",
					blocks: [],
					notes: [],
				},
				world,
			),
	);
	const stalled = x.apply({
		kind: "agent_stalled",
		agent: first.key,
		tokens: [first.expects[0]!.token],
		cause: "stopped",
		lastWords: "stale",
	});
	assert.deepEqual(stalled.send, []);
	x.apply({ kind: "queue_release", cause: "first" });
	assert.deepEqual(
		x.agents().map((a) => a.key),
		["verify/sibling"],
	);
	x.apply({
		kind: "queue_release",
		cause: "second",
		direction: "Before proceeding, inspect the test.",
	});
	const resumed = x.agents().find((a) => a.key === first.key)!;
	assert.notEqual(resumed.expects[0]?.token, first.expects[0]?.token);
	assert.match(resumed.expects[0]!.input!(), /inspect the test/);
});

test("diagnosed rework waits for the last queue hold regardless of answer order", () => {
	const x = flow();
	x.review();
	x.fail();
	for (const sha of ["fix-a", "fix-b"]) {
		x.publish(sha, ["totals"]);
		x.clean();
		x.checkout();
		x.fail();
	}
	const diagnosis = x.call(
		{
			kind: "diagnosis",
			premise: "No rounding before posting",
			test: "Compare both totals",
			result: "Pre-posting rounding differs",
		},
		"diagnoser",
	);
	const local = diagnosis.send?.find((m) => m.lane === "queue")?.event;
	assert.ok(local);
	x.apply(findingHold("boundary"));
	assert.deepEqual(x.apply(resume(local)).send, []);
	const result = x.apply({ kind: "queue_release", cause: "boundary" });
	const update = result.send?.find((m) => m.lane === "build")?.event;
	assert.equal(update?.kind, "rework");
	assert.match(String(update?.evidence), /Pre-posting rounding differs/);
	assert.match(String(update?.direction), /test the premise/);
});

test("a held unclaimed checkout does not start; drop restores its immutable plan", () => {
	const x = flow();
	x.publish();
	const first = x.effect("checkout");
	x.apply(findingHold("boundary"));
	assert.deepEqual(x.effects(), []);
	x.apply({ kind: "queue_release", cause: "boundary" });
	assert.deepEqual(x.effect("checkout"), first);
});

test("a held unclaimed merge yields the slot; dropping the hold re-pins to the sibling's merged head", () => {
	const x = flow();
	x.mergedBeforeConflict();
	const old = x.effect("merge_item");
	x.apply(findingHold("boundary"));
	assert.deepEqual(x.effects(), []);
	x.review("sibling-head", [], "sibling");
	x.pass();
	x.clean();
	assert.equal(x.effect("merge_item").op.item, "sibling-head");
	x.done("merge_item", { kind: "merged", sha: "sibling-merged", checks: [] });
	x.clean();
	x.apply({ kind: "queue_release", cause: "boundary" });
	const next = x.effect("merge_item");
	assert.notEqual(old.key, next.key);
	assert.equal(next.op.expected, "sibling-merged");
});

test("a revision returns obsolete publications after a claimed checkout settles, and removes the original target", () => {
	const x = flow();
	x.publish();
	const pending = x.effect("checkout");
	x.running.add(pending.key);
	x.apply(findingHold("boundary"));
	const changed = x.apply(revised());
	assert.ok(!changed.send?.some((m) => m.event.kind === "rework"));
	assert.ok(
		!x.effects().some((e) => (e.spec.op as LaneEvent).kind === "remove"),
	);
	x.running.delete(pending.key);
	const done = x.apply({
		kind: "effect_done",
		key: pending.key,
		result: { kind: "checkout", playbook: null },
	});
	assert.equal(x.agents().length, 0);
	assert.deepEqual(x.effect("remove").op.target, pending.op);
	assert.equal(
		done.send?.find((m) => m.lane === "build")?.event.reason,
		"mandate_revision",
	);
	assert.match(
		String(done.send?.find((m) => m.lane === "build")?.event.evidence),
		/revised ledger boundary/,
	);
});

test("a merged defect fix retires the blocked verifier publication so the filer can reprepare", () => {
	const x = flow();
	x.review();
	x.apply(findingHold("queue/1"));
	const result = x.apply({
		kind: "defect_fixed",
		item: "bug",
		evidence: "Decimal parsing is fixed.",
	});
	assert.equal(x.agents().length, 0);
	assert.equal(
		result.send?.find((m) => m.lane === "build")?.event.reason,
		"defect_fixed",
	);
});

test("a revision repins a queued merge's proof but records a claimed merge without rewriting it", () => {
	for (const claimed of [false, true]) {
		const x = flow();
		x.mergedBeforeConflict();
		const first = x.effect("merge_item");
		if (claimed) x.running.add(first.key);
		x.apply(revised(claimed ? ["bug"] : []));
		const next = x.effect("merge_item");
		if (claimed) assert.deepEqual(next, first);
		else {
			assert.notEqual(next.key, first.key);
			assert.deepEqual(next.op.checks, revised().mandate.checks);
		}
		x.running.delete(first.key);
		const done = x.done("merge_item", {
			kind: "merged",
			sha: "merged",
			checks: [],
		});
		assert.deepEqual(
			done.send?.filter((m) => m.lane === "build").map((m) => m.event.kind),
			["merged"],
		);
		assert.equal((x.effect("remove").op.target as LaneEvent).key, next.op.key);
		assert.deepEqual(x.apply(revised()).send, []);
	}
});

const resume = (file: LaneEvent) => ({
	kind: "resume",
	cause: file.cause!,
	item: file.item!,
	direction: "test the premise",
	evidence: file.evidence!,
});
test("Verify opens only the published checkout, renders the proof, brief, rulings and project playbook; inconsistent verdicts are refused", () => {
	const x = flow();
	x.publish("one", [], "bug", "base", {
		changedPolicyFiles: [
			".keel/principles/round.md",
			".keel/playbooks/check.md",
		],
		mandate: {
			...mandate,
			delegated: [
				{ label: "order", origin: "incidental", text: "Choose field order." },
			],
		},
	});
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
		'["run","proof"]',
		"Choose field order.",
		"Verifiers check the choices against those nodes.",
		".keel/principles/round.md",
		".keel/playbooks/check.md",
	])
		assert.ok(input.includes(expected), expected);
	assert.match(input, /unchanged unless[^.]*task/i);
	assert.doesNotMatch(input, /"intent":|"nodes":/);
	for (const [outcome, blocks] of [
		["fail", []],
		["pass", [block("a")]],
		["fail", [block("a"), block("a")]],
		["fail", [{ ...block("a"), ground: "" }]],
		["fail", [{ ...block("a"), evidence: " " }]],
	] as const) {
		assert.ok(
			"reject" in
				x.attempt({
					kind: "verdict",
					agent: a.key,
					text: "check",
					outcome,
					blocks: [...blocks],
					notes: [],
				}),
		);
	}
});
test("surviving two addressed fixes opens a fresh diagnosis, then a finding, then directed rework; resets the count", () => {
	const x = flow();
	x.review();
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
	x.review();
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
	x.review();
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
	x.review();
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
test("item merges serialize against successive heads with Mandate checks; verifier notes do not hold them", () => {
	const x = flow();
	x.publish("note-head", [], "bug", "base", { nodes: ["sums"] });
	const checked = x.effect("checkout").op;
	x.checkout();
	const pass = x.pass();
	const filings = pass.send?.filter((m) => m.lane === "queue") ?? [];
	assert.equal(filings.length, 1);
	const { work, event: note } = filings[0]!;
	assert.deepEqual(
		[
			work,
			note.kind,
			note.source,
			note.item,
			note.sha,
			note.nodes,
			note.blocking,
		],
		[null, "intake", "verifier", "bug", "note-head", ["sums"], false],
	);
	assert.equal(note.text, "monitor latency");
	assert.match(String(note.report), /totals now balance/);
	assert.deepEqual(pass.send?.find((m) => m.lane === "build")?.event, {
		kind: "item_verified",
		item: "bug",
	});
	assert.deepEqual(x.effect("remove").op.target, checked);
	x.clean();
	const op = x.effect("merge_item").op;
	assert.equal(op.item, "note-head");
	assert.equal(op.expected, "base");
	assert.deepEqual(op.checks, mandate.checks);
	x.review("two", [], "other");
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
// Merge conflicts name paths; take-trunk proof failures name the command and release the slot.
for (const { phase, failure, evidence } of [
	{
		phase: "merge_item",
		failure: { kind: "conflict", paths: ["balance.ts"], against: "other" },
		evidence: /balance\.ts/,
	},
	{
		phase: "take_trunk",
		failure: {
			kind: "checks_failed",
			sha: "candidate",
			checks: [{ id: "totals", code: 1, tail: "overflow at max amount" }],
		},
		evidence: /overflow at max amount/,
	},
]) {
	test(`${failure.kind} during ${phase} returns integration evidence without a verdict`, () => {
		const x = flow();
		const takingTrunk = phase === "take_trunk";
		if (takingTrunk) {
			x.full();
			x.take();
		} else x.mergedBeforeConflict();
		const op = x.effect(phase).op;
		const r = x.done(phase, failure);
		const event = r.send?.find((m) => m.lane === "build")?.event;
		assert.equal(event?.kind, "integration");
		assert.equal(event?.inheritedTrunk, takingTrunk ? "base" : undefined);
		assert.match(String(event?.evidence), evidence);
		assert.equal(x.state().verdicts.length, takingTrunk ? 2 : 1);
		assert.equal(
			r.send?.some((m) => m.event.kind === "release_slot"),
			takingTrunk,
		);
		assert.deepEqual(x.effect("remove").op.target, {
			kind: "checkout",
			key: op.key,
			path: op.integration,
		});
		if (!takingTrunk) {
			x.clean();
			x.review("corrected");
			const input = x.agent().expects[0]!.input!();
			assert.match(input, /worker revised/i);
			assert.match(input, /corrected/);
		}
	});
}
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
test("changed and unchanged landings withdraw cancel confirmation and redirect to hand-over", () => {
	for (const result of ["landed", "unchanged"]) {
		const desk = laneDriver(design, world);
		desk.send({
			kind: "ground",
			route: "follow",
			reference: "Ledger format",
			mandate,
		});
		const request = { kind: "request_cancel" };
		desk.send(request);
		const [confirmation] = desk.asks();
		assert.ok(confirmation);
		const x = flow();
		x.full();
		x.prepare();
		if (result === "landed")
			x.done("prepare_landing", { kind: "prepared", sha: "target" });
		const recorded = x.done(result === "landed" ? "land" : "prepare_landing", {
			kind: result,
			sha: result === "landed" ? "target" : "base",
		});
		if (result === "unchanged") {
			assert.ok(recorded.send?.some((m) => m.event.kind === "release_slot"));
			assert.deepEqual(x.effects(), []);
			assert.match(x.asks()[0]!.basis, /unchanged|no change/i);
		}
		for (const m of recorded.send ?? [])
			if (m.lane === "design" && m.work === world.work) desk.send(m.event);
		assert.deepEqual(desk.asks(), []);
		const late = desk.send({
			kind: "answered",
			subject: confirmation.subject,
			choice: "cancel",
			annotations: [],
		});
		assert.deepEqual(late.send ?? [], []);
		const again = desk.attempt(request);
		assert.match(
			"reject" in again ? again.reject : "",
			/landed[\s\S]*hand-over/i,
		);
	}
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
		x.review();
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
test("cancel after exhausted CAS settles the pinned landing before releasing its slot", () => {
	for (const outcome of ["landed", "moved", "unreadable"]) {
		const x = flow();
		x.prepared();
		const plan = x.effect("land");
		const failed = x.apply({
			kind: "effect_failed",
			key: plan.key,
			error: "lost git reply",
		});
		const file = failed.send?.find((m) => m.lane === "queue")?.event;
		assert.ok(file);
		// A pending redelivery doesn't prove the earlier attempt made no write.
		if (outcome === "moved") x.apply(resume(file));
		const cancelled = x.apply({ kind: "cancel" });
		assert.ok(
			!cancelled.send?.some(
				(m) =>
					m.event.kind === "release_slot" ||
					m.event.kind === "cleanup_finished",
			),
		);
		const replay = x.effect("land");
		assert.notEqual(replay.key, plan.key);
		assert.deepEqual(replay.op, plan.op);
		const reported =
			outcome === "unreadable"
				? x.apply({
						kind: "effect_failed",
						key: replay.key,
						error: "trunk read failed again",
					})
				: x.done(
						"land",
						outcome === "landed"
							? { kind: "landed", sha: "prepared" }
							: { kind: "moved", actual: "foreign-head" },
					);
		const note = reported.notes?.map((n) => n.text).join("\n") ?? "";
		if (outcome === "landed")
			assert.match(note, /landed on trunk at prepared/i);
		else if (outcome === "moved") assert.match(note, /trunk.*foreign-head/i);
		else {
			assert.match(note, /unknown|could not (confirm|determine)|unconfirmed/i);
			assert.match(note, /trunk read failed again/);
			assert.match(note, /prepared/);
		}
		assert.ok(reported.send?.some((m) => m.event.kind === "release_slot"));
		assert.ok(reported.send?.some((m) => m.event.kind === "cleanup_finished"));
		assert.deepEqual(x.effects(), []);
		assert.deepEqual(x.asks(), []);
	}
});

test("a retry that observed a foreign trunk before cancellation needs no further CAS", () => {
	const x = flow();
	x.prepared();
	const failed = x.apply({
		kind: "effect_failed",
		key: x.effect("land").key,
		error: "lost git reply",
	});
	const file = failed.send?.find((m) => m.lane === "queue")?.event;
	assert.ok(file);
	x.apply(resume(file));
	x.done("land", { kind: "moved", actual: "foreign-head" });
	const cancelled = x.apply({ kind: "cancel" });
	assert.ok(cancelled.send?.some((m) => m.event.kind === "release_slot"));
	assert.deepEqual(x.effects(), []);
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
test("full-set and landing reviews report the union of merged publications, not reverted policy changes", () => {
	const x = flow();
	const reverted = ".keel/principles/reverted.md";
	const shared = ".keel/playbooks/shared.md";
	const first = ".keel/principles/first.md";
	const second = ".keel/playbooks/second.md";
	x.publish("first", [], "bug", "base", {
		changedPolicyFiles: [first, reverted],
	});
	x.checkout();
	x.fail();
	x.publish("corrected", ["totals"], "bug", "base", {
		changedPolicyFiles: [first, shared],
	});
	x.clean();
	const pass = () =>
		x.call({
			kind: "verdict",
			outcome: "pass",
			text: "proof passes",
			blocks: [],
			notes: [],
		});
	function merge(sha: string) {
		x.checkout();
		pass();
		x.clean();
		x.done("merge_item", { kind: "merged", sha, checks: [] });
		x.clean();
	}
	merge("first-merged");
	x.publish("second", [], "another", "first-merged", {
		changedPolicyFiles: [second, shared],
	});
	merge("merged");
	function expectPolicyList(scope: string) {
		const input = x.agent().expects[0]!.input!();
		const list = input.match(
			/Changed principles and playbooks reported by Git:\n([^\n]+(?:\n[^\n]+)*)/,
		);
		assert.ok(list, scope);
		assert.match(
			input,
			/unchanged unless an item under review was tasked/i,
			scope,
		);
		assert.deepEqual(
			list[1]!.split("\n").sort(),
			[first, second, shared].sort(),
			scope,
		);
	}
	x.handoff();
	x.checkout();
	expectPolicyList("full-set");
	pass();
	x.clean();
	x.prepare("advanced-trunk");
	x.done("prepare_landing", { kind: "prepared", sha: "prepared" });
	x.checkout();
	expectPolicyList("landing");
});

test("hand-over retains the chosen ambiguity reading and numbered annotations from Ground", () => {
	const x = flow();
	const readings = ["Use the venue minimum.", "Use the exchange minimum."];
	const grounded = design.reduce(
		design.state.initial(),
		{
			kind: "ground",
			route: "ambiguous",
			reference: "Lot size varies by venue.",
			readings,
		},
		world,
	);
	assert.ok("state" in grounded);
	const result = drive(
		design,
		grounded.state,
		{
			kind: "answered",
			subject: design.asks(grounded.state, world)[0]!.subject,
			choice: "second",
			annotations: [
				{ n: 1, text: "Include auctions." },
				{ n: 2, text: "Keep the open market separate." },
			],
		},
		world,
	);
	assert.ok("state" in result);
	for (const m of result.send ?? [])
		if (m.lane === "verify" && m.work === world.work) x.apply(m.event);
	x.land();
	const basis = x.asks()[0]!.basis;
	assert.ok(basis.includes(readings[1]!));
	assert.match(basis, /1\. Include auctions\./);
	assert.match(basis, /2\. Keep the open market separate\./);
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
	x.land();
	for (const lane of ["design", "build", "verify"])
		assert.ok(x.asks()[0]!.basis.includes("follow " + lane));
});
test("verifier resume uses a fresh token and fresh direction; duplicate, stale and fulfilled stops are inert", () => {
	const x = flow();
	x.review();
	const stop = () => ({
		kind: "agent_stalled",
		agent: x.agent().key,
		tokens: [x.agent().expects[0]!.token],
		cause: "stopped",
		lastWords: "compare failed",
	});
	const old = stop();
	const file = x.apply(old).send?.[0]?.event;
	assert.ok(file);
	assert.match(String(file.evidence), /compare failed/);
	assert.deepEqual(x.agents(), []);
	assert.ok(!x.apply(old).send?.length);
	x.apply({ ...resume(file), direction: "inspect rounding" });
	const next = stop();
	assert.notDeepEqual(next.tokens, old.tokens);
	assert.ok(!x.apply(old).send?.length);
	assert.match(x.agent().expects[0]!.input!(), /inspect rounding/);
	const other = x.apply(next).send?.[0]?.event;
	assert.ok(other);
	x.apply({ ...resume(other), direction: "inspect carries" });
	const input = x.agent().expects[0]!.input!();
	assert.match(input, /inspect carries/);
	assert.doesNotMatch(input, /inspect rounding/);
	const fulfilled = stop();
	x.pass();
	assert.ok(!x.apply(fulfilled).send?.length);
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
			x.review();
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
	y.review();
	y.pass();
	const old = y.effect("remove");
	y.done("remove", { kind: "occupied", path: "obstruction" });
	y.apply({ kind: "cancel" });
	assert.notEqual(y.effect("remove").key, old.key);
	assert.deepEqual(y.effect("remove").op.target, old.op.target);
});
test("the landing slot gates CAS; reviewed hand-over prioritizes high-cost evidence and accepts without Git", () => {
	const revisionSummary = "- Revision 1: sums (falsifying probe)";
	const x = flow((lane) =>
		lane === "design"
			? {
					ownerReviewed: true,
					reference: "Approved ledger contract §2",
					revisionSummary,
				}
			: null,
	);
	assert.deepEqual(
		x.full().send?.map(({ lane, event }) => [lane, event.kind]),
		[["trunk", "take_slot"]],
	);
	assert.deepEqual(x.effects(), []);
	const { op } = x.prepare();
	x.done("prepare_landing", { kind: "prepared", sha: "prepared" });
	assert.deepEqual(x.effect("land").op, {
		...(op.landing as object),
		kind: "land",
		target: "prepared",
	});
	assert.deepEqual(x.agents(), []);
	assert.ok(
		x
			.done("land", { kind: "landed", sha: "prepared" })
			.send?.some((m) => m.event.kind === "release_slot"),
	);
	const { basis, subject } = x.asks()[0]!;
	assert.ok(basis.includes(revisionSummary));
	assert.doesNotMatch(
		basis,
		/Bound Mandate|Approved ledger contract|Timeout: 10 ms/,
	);
	assert.match(basis, /high ruling[\s\S]*low ruling/);
	for (const evidence of [
		"prepared",
		"Balance every ledger.",
		"totals now balance",
		"monitor latency",
		"low volume only",
		"explain-the-number",
		"small",
		"large",
	])
		assert.ok(basis.includes(evidence), evidence);
	const answer = {
		kind: "answered",
		subject,
		choice: "accept",
		annotations: [],
	};
	const closed = x.apply(answer);
	assert.deepEqual(closed.send?.map((m) => [m.lane, m.event.kind]).sort(), [
		["build", "closed"],
		["design", "closed"],
	]);
	assert.deepEqual(x.effects(), []);
	assert.deepEqual(x.asks(), []);
	assert.ok(!x.apply(answer).send?.length);
});
