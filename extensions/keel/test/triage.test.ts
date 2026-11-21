import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { queueLane } from "../src/lanes/queue/index.ts";
import { drive } from "./fixtures/drive.ts";

const plan = [
	{
		id: "ledger",
		goal: "Compare both ledger balances",
		stage: "building",
		nodes: ["sums"],
		deps: [],
	},
];
const activeWorld: World = {
	work: null,
	root: "/checkout",
	now: 1,
	options: {
		build: "x/a",
		verify: "x/b",
		design: "x/c",
		queue: "x/d",
		max_workers: 2,
		base: "main",
		trunk: "trunk",
	},
	view: (lane) =>
		lane === "build"
			? { phase: "active", plan }
			: {
					mandate: {
						intent: "Post each cent once.",
						nodes: [
							{
								label: "sums",
								rule: "Round once.",
								probe: "Post a half-cent.",
							},
						],
						checks: [],
						delegated: [],
						considerations: null,
					},
				},
};
const filing = {
	kind: "intake",
	work: 4,
	source: "worker",
	item: "ledger",
	sha: "commit-one",
	text: "Which rounding boundary?",
	report: "The two calculations disagree by 1.",
	nodes: ["sums"],
	edgeCase: null,
	pattern: null,
	blocking: false,
};
function queue(world: World = activeWorld) {
	return queueLane.use((l) => {
		let s = l.state.initial();
		const attempt = (e: LaneEvent) => drive(l, s, e, world);
		const send = (e: LaneEvent) => {
			const r = attempt(e);
			if ("reject" in r) assert.fail(r.reject);
			s = r.state;
			return r.send ?? [];
		};
		const file = (over: Partial<LaneEvent> = {}) =>
			send({ ...filing, ...over } as LaneEvent);
		const investigation = (
			finding = 1,
			classification = "determined",
			extra: LaneEvent[string] = {},
		) => ({
			kind: "investigated",
			finding,
			classification,
			evidence: "Compared both totals at the posting boundary.",
			size: "small",
			cause: "rounding point",
			recommendation: "build",
			reference: "signed spec",
			batchWith: [],
			nodes: ["sums"],
			...(extra as object),
		});
		const ask = () => l.asks(s, world);
		const answer = (choice: string, subject = ask()[0]!.subject) =>
			send({
				kind: "answered",
				subject,
				choice,
				decision: "d1",
				annotations: [{ n: 1, text: "Use the ledger boundary." }],
			});
		const agents = () => l.agents(s, world);
		return {
			send,
			file,
			attempt,
			investigation,
			ask,
			answer,
			agents,
			state: () => s,
		};
	});
}

test("filing twice opens one investigation with the source revision, report, nodes and current plan; owner input schedules no work", () => {
	const q = queue();
	for (let i = 0; i < 2; i++)
		assert.deepEqual(q.file({ source: "owner", item: null }), []);
	assert.deepEqual(q.ask(), []);
	const agents = q.agents();
	assert.equal(agents.length, 1);
	assert.equal(agents[0]?.role, "investigator");
	const [turn] = agents[0]!.expects;
	for (const part of [
		"commit-one",
		filing.text,
		filing.report,
		"sums",
		"Post each cent once.",
		plan[0]!.goal,
	])
		assert.ok(turn?.input?.().includes(part), part);
	q.file({ text: "second report" });
	assert.equal(q.agents().length, 1);
	assert.equal(q.agents()[0]?.expects.length, 1);
});
test("an unlikely edge case without likelihood and a blocking filing without an own item are refused", () => {
	const q = queue();
	for (const over of [
		{
			edgeCase: {
				failure: "overflow",
				likelihood: " ",
				cost: "second representation",
			},
		},
		{ source: "owner", blocking: true, item: null },
	])
		assert.ok("reject" in q.attempt({ ...filing, ...over }));
	assert.deepEqual(q.agents(), []);
	assert.ok(
		"reject" in
			q.attempt({
				...filing,
				blocking: true,
				edgeCase: { failure: "overflow", likelihood: "rare", cost: "new type" },
			}),
	);
});
test("a blocking filer holds only itself; classification holds named nodes immediately and drop releases the cause", () => {
	const q = queue();
	const [own] = q.file({ blocking: true });
	assert.deepEqual(
		[own?.lane, own?.work, own?.event.kind, own?.event.item, own?.event.nodes],
		["build", 4, "queue_hold", "ledger", []],
	);
	const [nodes] = q.send(q.investigation(1, "mandate_wrong"));
	assert.deepEqual(
		[nodes?.event.kind, nodes?.event.nodes, nodes?.event.cause],
		["queue_hold", ["sums"], own?.event.cause],
	);
	const subject = q.ask()[0]!.subject;
	const [release] = q.answer("drop");
	assert.deepEqual(
		[release?.lane, release?.event.kind, release?.event.cause],
		["build", "queue_release", own?.event.cause],
	);
	assert.deepEqual(q.answer("build", subject), []);
	assert.match(JSON.stringify(q.state()), /dropped/);
});
test("one cause and one decision can be batched; one answer seeds just one design with both reports", () => {
	const q = queue();
	q.file();
	q.file({ text: "Second discrepancy" });
	q.send(q.investigation(1, "sets_precedent"));
	const stale = q.ask()[0]!.subject;
	q.send(q.investigation(2, "sets_precedent", { batchWith: [1] }));
	assert.equal(q.ask().length, 1);
	for (const text of [filing.text, "Second discrepancy"])
		assert.ok(q.ask()[0]!.basis.includes(text));
	assert.deepEqual(q.answer("build", stale), []);
	const seeds = q.answer("build").filter((m) => m.work === "new");
	assert.equal(seeds.length, 1);
	assert.equal(seeds[0]?.lane, "design");
	assert.equal(seeds[0]?.event.route, "precedent");
	assert.match(String(seeds[0]?.event.text), /Second discrepancy/);
});
test("same choices do not make different causes, references or classifications one decision", () => {
	const q = queue();
	q.file();
	q.file({ text: "Other discrepancy" });
	q.send(q.investigation());
	for (const [cls, extra] of [
		["determined", { cause: "other" }],
		["determined", { reference: "another spec" }],
		["sets_precedent", {}],
	] as const)
		assert.ok(
			"reject" in
				q.attempt(q.investigation(2, cls, { batchWith: [1], ...extra })),
		);
	q.send(q.investigation(2, "sets_precedent"));
	assert.equal(q.ask().length, 2);
});
test("a defect goes to the coordinator without triage; determined work waits for build", () => {
	for (const cls of ["defect_in_scope", "determined"]) {
		const q = queue();
		q.file();
		let out = q.send(q.investigation(1, cls));
		if (cls === "determined") {
			assert.deepEqual(out, []);
			out = q.answer("build");
		}
		assert.equal(q.ask().length, 0);
		assert.deepEqual(
			out.map((m) => [m.lane, m.work, m.event.kind]),
			[["build", 4, "plan_finding"]],
		);
		assert.match(String(out[0]?.event.text), /calculations disagree/);
		assert.deepEqual(out[0]?.event.nodes, ["sums"]);
		assert.equal(
			out[0]?.event.reference,
			cls === "determined" ? "signed spec" : "Current Mandate",
		);
	}
});
test("duplicates link to the original, retain a blocking report until its answer, and deferred findings stay addressable", () => {
	const q = queue();
	q.file();
	q.file({
		text: "Same issue in another item",
		item: "second",
		blocking: true,
	});
	q.send(q.investigation());
	const out = q.send(q.investigation(2, "duplicate", { duplicateOf: 1 }));
	assert.deepEqual(out, []);
	assert.equal(q.ask().length, 1);
	const released = q.answer("defer");
	assert.equal(
		released.filter((m) => m.event.kind === "queue_release").length,
		1,
	);
	assert.match(JSON.stringify(q.state()), /deferred/);
	assert.match(JSON.stringify(q.state()), /"duplicateOf":1/);
});
test("a blessed pattern is an approved reference across works; revoke seeds structural correction instead", () => {
	for (const choice of ["bless", "revoke"]) {
		const q = queue();
		q.file({ pattern: "round-last" });
		q.send(
			q.investigation(1, "unapproved_pattern", { recommendation: choice }),
		);
		assert.deepEqual(q.ask()[0]!.choices, ["bless", "revoke", "defer"]);
		const out = q.answer(choice);
		if (choice === "bless") {
			q.file({ work: 5, text: "later ruling", pattern: "round-last" });
			assert.equal(q.agents().flatMap((a) => a.expects).length, 0);
			assert.doesNotMatch(JSON.stringify(q.state()), /later ruling/);
		} else {
			assert.equal(out[0]?.work, "new");
			assert.match(String(out[0]?.event.text), /round-last/);
		}
	}
});
test("blessing a pattern withdraws other open decisions and investigations for that pattern", () => {
	const q = queue();
	for (const text of ["First ruling", "Another ruling", "Third ruling"])
		q.file({ text, pattern: "round-last" });
	for (const id of [1, 2])
		q.send(
			q.investigation(id, "unapproved_pattern", { recommendation: "bless" }),
		);
	const [first, second] = q.ask();
	assert.ok(first && second);
	assert.deepEqual(q.answer("bless", first.subject), []);
	assert.deepEqual(q.ask(), []);
	assert.equal(q.agents()[0]?.expects.length, 0);
	assert.deepEqual(q.answer("revoke", second.subject), []);
});

test("determined work whose original build closed seeds new follow work with its reference", () => {
	let phase = "active";
	const q = queue({
		...activeWorld,
		view: (lane) =>
			lane === "build" ? { phase, plan } : activeWorld.view(lane),
	});
	q.file();
	q.send(q.investigation());
	phase = "closed";
	const [seed] = q.answer("build");
	assert.equal(seed?.lane, "design");
	assert.equal(seed?.work, "new");
	assert.equal(seed?.event.kind, "queue_seed");
	assert.equal(seed?.event.route, "follow");
	assert.equal(seed?.event.reference, "signed spec");
	assert.match(String(seed?.event.text), /Use the ledger boundary/);
});

test("approving triage asks the designer of the same work for a revision and keeps both causes held", () => {
	const q = queue();
	const [own] = q.file({ blocking: true });
	q.send(q.investigation(1, "mandate_wrong"));
	q.file({
		text: "Try a half-cent",
		report: "The smallest amount that disagrees.",
	});
	const [second] = q.send(
		q.investigation(2, "mandate_wrong", { batchWith: [1] }),
	);
	const out = q.answer("build");
	assert.equal(out.length, 1);
	assert.equal(out[0]?.lane, "design");
	assert.equal(out[0]?.work, 4);
	assert.equal(out[0]?.event.kind, "revise_mandate");
	assert.deepEqual(out[0]?.event.causes, [
		own?.event.cause,
		second?.event.cause,
	]);
	assert.deepEqual(out[0]?.event.nodes, ["sums"]);
	assert.match(
		String(out[0]?.event.text),
		/smallest amount[\s\S]+Use the ledger boundary/,
	);
});

test("an investigation must answer the head finding and name its evidence, authority and affected nodes", () => {
	const q = queue();
	q.file();
	q.file({ text: "Second" });
	for (const report of [
		q.investigation(2),
		q.investigation(1, "determined", { reference: " " }),
		q.investigation(1, "mandate_wrong", { nodes: [] }),
		q.investigation(1, "mandate_wrong", { nodes: ["not-in-mandate"] }),
		q.investigation(1, "duplicate", { duplicateOf: 1 }),
		q.investigation(1, "determined", { evidence: " " }),
	])
		assert.ok("reject" in q.attempt(report), JSON.stringify(report));
	assert.deepEqual(q.ask(), []);
	assert.match(
		q.agents()[0]?.expects[0]?.input?.() ?? "",
		/Which rounding boundary/,
	);
});

test("cancelling a work closes only its wrong-Mandate decisions and makes old answers inert", () => {
	const q = queue();
	q.file();
	q.send(q.investigation(1, "mandate_wrong"));
	const cancelled = q.ask()[0]!.subject;
	q.file({ text: "Independent follow-up" });
	q.send(q.investigation(2, "determined"));
	q.file({ work: 5, text: "Another work's Mandate" });
	q.send(q.investigation(3, "mandate_wrong"));
	const out = q.send({ kind: "cancel_work", work: 4 });
	assert.equal(out.length, 3);
	assert.ok(out.every((m) => m.work === 4 && m.event.kind === "cancel"));
	assert.deepEqual(q.answer("build", cancelled), []);
	const remaining = q.ask().map((ask) => ask.basis);
	assert.equal(remaining.length, 2);
	assert.ok(remaining.some((basis) => basis.includes("Independent follow-up")));
	assert.ok(
		remaining.some((basis) => basis.includes("Another work's Mandate")),
	);
	assert.match(JSON.stringify(q.state()), /cancelled/);
});

test("a deferred Mandate finding releases its causes just as a dropped one does", () => {
	const q = queue();
	q.file();
	const [hold] = q.send(q.investigation(1, "mandate_wrong"));
	const out = q.answer("defer");
	assert.deepEqual(
		out.map((m) => [m.lane, m.work, m.event.kind, m.event.cause]),
		[["build", 4, "queue_release", hold?.event.cause]],
	);
	assert.match(String(out[0]?.event.direction), /Use the ledger boundary/);
	assert.deepEqual(q.ask(), []);
	assert.match(JSON.stringify(q.state()), /deferred/);
});

test("investigator stop is left to the owner; resume declares a fresh input for the same finding", () => {
	const q = queue();
	q.file();
	const a = q.agents()[0]!;
	const tok = a.expects[0]!.token;
	q.send({
		kind: "agent_stalled",
		cause: "stopped",
		agent: a.key,
		tokens: [tok],
		lastWords: "waiting for evidence",
	});
	assert.equal(q.agents().flatMap((a) => a.expects).length, 0);
	assert.match(q.ask()[0]!.basis, /waiting for evidence/);
	const basis = q.ask()[0]!.basis;
	q.answer("resume");
	const exp = q.agents()[0]?.expects[0];
	const input = exp?.input?.() ?? "";
	assert.ok(input.includes(filing.text));
	assert.match(input, /Use the ledger boundary\./);
	assert.match(input, /Compare both ledger balances/);
	assert.match(basis, /Cancel drops the finding/);
	assert.notEqual(exp?.token, tok);
});
