import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "tau/durable";
import { buildLane } from "../src/lanes/build/index.ts";
import { type buildView, validateGraph } from "../src/lanes/build/state.ts";
import type { Mandate } from "../src/lanes/design/public.ts";
import { startBuild } from "./fixtures/build.ts";
import { holdingChoice, laneDriver, laneWorld } from "./fixtures/drive.ts";

const mandate: Mandate = {
	delegated: [],
	encodeRequired: false,
	approvalNotes: [] as string[],
	intent: "repair pricing",
	considerations: null,
	nodes: [{ label: "price", rule: "round once", probe: "0.05" }],
	checks: [{ id: "prove", argv: ["make", "test"], timeoutMs: 5000 }],
};
const { work, root } = laneWorld();
const repo = {
	root,
	commonDir: "/repo/.git",
	base: "main",
	trunk: "trunk",
	baseHead: "a".repeat(40),
	trunkHead: "b".repeat(40),
};
const sha = "c".repeat(40);
const merged = "d".repeat(40);
const brief = {
	item: "fix",
	goal: "price safely",
	evidence: "works at ties",
	fences: "src/pricing.ts",
	nodes: ["price"],
};
const ruling = {
	what: "integer",
	why: "exact",
	cost: "migration",
	rank: 2,
	follows: "existing price model",
	principles: [],
};
const item = {
	id: "fix",
	kind: "build" as const,
	goal: "fix rounding",
	deps: [],
};
const clean = {
	kind: "ok",
	sha,
	base: repo.trunkHead,
	changedPolicyFiles: [],
};
function setup(max_workers = 1) {
	const world = laneWorld({ options: { max_workers } });
	return buildLane.use((lane) => {
		const driver = laneDriver(lane, world);
		const { send, done, effects, agents } = driver;
		const agent = (role: string) => {
			const a = agents().find((a) => a.role === role);
			assert.ok(a);
			return a;
		};
		const effect = () => {
			const e = effects()[0];
			assert.ok(e);
			return e;
		};
		const start = (bound = mandate) => startBuild(driver, bound, repo);
		function plan(items: JsonObject[] = [item]) {
			start();
			send({ kind: "plan", items });
		}
		const briefItem = (id = "fix", overrides: JsonObject = {}) =>
			send({ kind: "brief", ...brief, item: id, ...overrides });
		const ready = (
			base = repo.trunkHead,
			key?: ReturnType<typeof effect>["key"],
		) => done({ kind: "worktree", base, principles: [] }, key);
		const workOn = (id = "fix", base = repo.trunkHead) => {
			briefItem(id);
			ready(base);
		};
		function prepare(kind = "build") {
			plan([{ ...item, kind }]);
			briefItem();
		}
		function working(kind = "build") {
			prepare(kind);
			ready();
		}
		const pub = (facts: JsonObject = clean, addresses: string[] = []) =>
			send({
				kind: "publish",
				agent: agent("worker").key,
				summary: "patched",
				addresses,
				facts,
			});
		const request = (role: string) => {
			const exp = agent(role).expect;
			assert.ok(exp?.input);
			return { token: exp.token, tools: exp.tools, text: exp.input() };
		};
		return {
			...driver,
			resume: (direction = "") =>
				send(holdingChoice(driver.asks()[0]!, "resume", direction)),
			world,
			publication: () =>
				(driver.view() as ReturnType<typeof buildView>).publicationOf(
					agent("worker").key,
				),
			start,
			plan,
			prepare,
			working,
			briefItem,
			ready,
			workOn,
			pub,
			tryEvent: driver.attempt,
			agent,
			request,
			effect,
		};
	});
}

test("Build discovers the repo and starts the build before opening planning", () => {
	const b = setup();
	b.send({ kind: "bound", mandate });
	assert.deepEqual(b.effect().spec, {
		kind: "read_repo",
		base: "main",
		trunk: "trunk",
	});
	assert.deepEqual(b.agents(), []);
	b.done({ kind: "repo", repo });
	assert.deepEqual(b.effect().spec.op, {
		kind: "start_build",
		key: b.effect().key,
		branch: "keel/32/build",
	});
	assert.deepEqual(b.agents(), []);
	b.done({ kind: "started", base: repo.trunkHead });
	const r = b.request("coordinator");
	assert.deepEqual(r.tools, ["publish_plan"]);
	assert.match(r.text, /repair pricing/);
});

test("plan validation refuses missing goals, invalid IDs and unsatisfiable dependencies", () => {
	const table: [string, Parameters<typeof validateGraph>[1], RegExp][] = [
		["empty", [], /at least one item/],
		["duplicate", [item, item], /unique/],
		["path", [{ ...item, id: "../a" }], /lowercase/],
		["reserved", [{ ...item, id: "full" }], /reserved/],
		["unknown dependency", [{ ...item, deps: ["later"] }], /missing/],
		[
			"cycle",
			[
				{ ...item, deps: ["next"] },
				{ ...item, id: "next", deps: ["fix"] },
			],
			/cycle/,
		],
	];
	for (const [failure, goals, reason] of table)
		assert.match(validateGraph([], goals) ?? "", reason, failure);
});

const reviewed: Mandate = {
	...mandate,
	encodeRequired: true,
	approvalNotes: ["Cover cash ties", "Keep the integer seam"],
	delegated: [
		{
			label: "tick-order",
			text: "Choose tick order locally",
			origin: "incidental",
		},
	],
	nodes: [
		{ label: "port-api", section: "Seam", body: "```ts\nprice(cents);\n```" },
		{
			label: "cash-port",
			rule: "Price takes cents",
			probe: "fractional cents fail",
		},
	],
};
const encode = { ...item, kind: "encode", goal: "protect the cash port" };
const replies = [
	{ n: 2, status: "considered", reason: "the seam already takes integers" },
	{ n: 1, status: "acted_on", reason: "pin the tie predicate in the scaffold" },
];

test("a reviewed seam requires Encode first and a direct dependency from every later item", () => {
	const b = setup();
	b.start({ ...reviewed, approvalNotes: [] });
	const later = { ...item, id: "later" };
	for (const items of [
		[item],
		[later, encode],
		[encode, later],
		[
			encode,
			{ ...later, deps: ["fix"] },
			{ ...item, id: "end", deps: ["later"] },
		],
	]) {
		const result = b.tryEvent({ kind: "plan", items });
		assert.match("reject" in result ? result.reject : "", /encode/i);
	}
	b.send({ kind: "plan", items: [encode, { ...later, deps: ["fix"] }] });
	assert.match(b.request("coordinator").text, /protect the cash port/);
});

test("approval notes require a numbered reply each; the first plan and its cited nodes survive briefing and correction", () => {
	const b = setup();
	b.start(reviewed);
	const prompt = b.request("coordinator").text;
	assert.match(prompt, /1\. Cover cash ties/);
	assert.match(prompt, /2\. Keep the integer seam/);
	assert.match(prompt, /Price takes cents/);
	assert.match(prompt, /Seam[\s\S]*```ts\nprice\(cents\);\n```/);
	assert.match(
		prompt,
		/delegated[\s\S]*tick-order[\s\S]*Choose tick order locally/i,
	);
	for (const bad of [
		[],
		replies.slice(1),
		[replies[0]!, replies[0]!],
		[replies[0]!, { ...replies[1]!, n: 3 }],
		[replies[0]!, { ...replies[1]!, status: "ignored" }],
		[replies[0]!, { ...replies[1]!, reason: "  " }],
	]) {
		const r = b.tryEvent({ kind: "plan", items: [encode], replies: bad });
		assert.match("reject" in r ? r.reject : "", /repl|annotat/i);
	}
	b.send({ kind: "plan", items: [encode], replies });
	const approvals = [
		{
			revision: null,
			notes: [
				{ ...replies[1], text: "Cover cash ties" },
				{ ...replies[0], text: "Keep the integer seam" },
			],
		},
	];
	assert.ok(
		"reject" in b.tryEvent({ kind: "brief", ...brief, nodes: ["tick-order"] }),
	);
	b.send({ kind: "brief", ...brief, nodes: ["cash-port", "port-api"] });
	b.ready();
	assert.match(b.request("worker").text, /Item: fix \(encode\)/);
	assert.match(
		b.request("worker").text,
		/delegated[\s\S]*Choose tick order locally/i,
	);
	const report = String(b.pub().send![0]!.event.brief);
	assert.match(report, /cash-port/);
	assert.match(report, /port-api/);
	assert.doesNotMatch(report, /tick-order/);
	assert.match(report, /Price takes cents/);
	assert.match(report, /fractional cents fail/);
	b.send({ kind: "merged", item: "fix", head: merged });
	b.done({ kind: "removed" });
	const handoff = b.send({
		kind: "handoff",
		summary: "port ready",
		risk: "none",
	});
	assert.deepEqual(handoff.send?.[0]?.event.approvals, approvals);
	b.send({
		kind: "rework",
		item: "full",
		head: merged,
		threads: ["proof"],
		evidence: "tie proof failed",
	});
	const correction = b.send({
		kind: "plan",
		items: [{ ...item, id: "proof", deps: ["fix"] }],
	});
	assert.ok("approvals" in correction.state);
	assert.deepEqual(correction.state.approvals, approvals);
});

test("briefs require ready work and bound labels; only a confirmed worktree starts a worker", () => {
	const b = setup();
	b.plan([item, { ...item, id: "later", deps: ["fix"] }]);
	for (const e of [
		{ kind: "brief", ...brief, item: "later" },
		{ kind: "brief", ...brief, nodes: ["unknown"] },
		{ kind: "brief", ...brief, nodes: [] },
		{ kind: "brief", ...brief, fences: "book.sh and book-check.sh" },
		{ kind: "handoff", summary: "done", risk: "none" },
	])
		assert.ok("reject" in b.tryEvent(e));
	assert.deepEqual(b.effects(), []);
	b.briefItem();
	const { op } = b.effect().spec;
	assert.deepEqual(op, {
		kind: "worktree",
		key: b.effect().key,
		path: "/repo/.git/keel/32/worker-fix-1",
		from: "keel/32/build",
		branch: "keel/32/item/fix-1",
		base: repo.trunkHead,
	});
	assert.equal(b.agents().length, 1);
	b.ready();
	assert.equal(b.agent("worker").cwd, "/repo/.git/keel/32/worker-fix-1");
	for (const fact of [brief.evidence, brief.fences, mandate.intent])
		assert.ok(b.request("worker").text.includes(fact));
});

test("briefs use spare worker slots but never start pending dependencies or exceed the limit", () => {
	const b = setup(2);
	b.plan([
		item,
		{ ...item, id: "later", deps: ["fix"] },
		{ ...item, id: "other" },
		{ ...item, id: "third" },
	]);
	b.briefItem();
	assert.match(b.request("coordinator").text, /other/);
	b.briefItem("other");
	assert.equal(b.agent("coordinator").expect, null);
	assert.equal(b.effects().length, 2);
});

test("dirty and unrelated work cannot publish", () => {
	const b = setup();
	b.working();
	const exp = b.request("worker");
	for (const facts of [
		{ kind: "dirty", files: ["book"] },
		{ kind: "not_descendant" },
	])
		assert.ok(
			"reject" in
				b.tryEvent({
					kind: "publish",
					agent: b.agent("worker").key,
					addresses: [],
					summary: "no",
					facts,
				}),
		);
	assert.equal(b.request("worker").token, exp.token);
});

test("build returns re-open the same worker; only a survived rework fix requests a premise check", () => {
	const b = setup();
	b.plan();
	b.briefItem("fix", { fences: "./src/money/./tick.ts\n\n tests/tie.ts " });
	const paths = ["src/money/tick.ts", "tests/tie.ts"];
	const policy = [
		{
			name: "money",
			body: "---\ndescription: Use whole cents.\n---\nPin cents at this base.",
		},
	];
	b.done({ kind: "worktree", base: repo.trunkHead, principles: policy });
	const worker = b.agent("worker");
	const cited = { ...ruling, principles: ["prove-it-works"] };
	b.send({ kind: "ruling", agent: worker.key, ruling: cited });
	assert.deepEqual(worker.expect?.paths, paths);
	assert.notEqual(worker.expect?.situation, "survived_fix");
	assert.deepEqual(worker.projectPrinciples, policy);
	const first = b.pub().send![0]!;
	assert.deepEqual(
		[first.lane, first.event.kind, first.event.sha, first.event.head],
		["verify", "published", sha, repo.trunkHead],
	);
	assert.deepEqual(first.event.paths, paths);
	assert.deepEqual(first.event.rulings, [cited]);
	assert.match(String(first.event.brief), /works at ties[\s\S]*patched/);

	let previous = worker.expect!.token;
	for (const [kind, evidence, threads, survived] of [
		["rework", "wrong rounding", ["tie"], false],
		["rework", "the rounding fix failed", ["tie"], true],
		["integration", "merge conflict in book", [], false],
	] as const) {
		b.send({ kind, item: "fix", evidence, threads: [...threads] });
		const resumed = b.agent("worker");
		const turn = resumed.expect;
		assert.ok(turn);
		assert.equal(resumed.key, worker.key);
		assert.notEqual(turn.token, previous);
		previous = turn.token;
		assert.equal(turn.situation === "survived_fix", survived);
		assert.deepEqual(turn.paths, paths);
		assert.deepEqual(resumed.projectPrinciples, policy);
		const input = turn.input!();
		assert.ok(input.includes(evidence), kind);
		if (threads.length) assert.match(input, /tie/);
		else assert.doesNotMatch(input, /Threads:\s*\n/i);
		assert.deepEqual(
			b.pub(undefined, [...threads]).send![0]!.event.addresses,
			threads,
		);
	}
});

test("the verifier receives the repo's comparison base, not the current head or original attempt base", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.workOn();
	b.workOn("other");
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	const inherited = "f".repeat(40);
	const changedPolicyFiles = [
		".keel/principles/round.md",
		".keel/playbooks/check.md",
	];
	const result = b.pub({ ...clean, base: inherited, changedPolicyFiles });
	assert.equal(result.send?.length, 1);
	const [publication] = result.send!;
	assert.equal(publication?.lane, "verify");
	assert.deepEqual(
		[
			publication?.event.head,
			publication?.event.base,
			publication?.event.changedPolicyFiles,
		],
		[merged, inherited, changedPolicyFiles],
	);
	assert.equal(b.agent("worker").paused, false);
});

for (const outcome of ["occupied", "moved", "effect_failed"]) {
	test(`${outcome} in worktree preparation files the evidence and retries only on direction`, () => {
		const b = setup();
		b.prepare();
		const first = b.effect();
		const fact =
			outcome === "effect_failed"
				? { kind: outcome, key: first.key, error: "read failed" }
				: {
						kind: "effect_done",
						key: first.key,
						result:
							outcome === "occupied"
								? { kind: outcome, path: "/foreign" }
								: { kind: outcome, actual: sha },
					};
		assert.deepEqual(b.send(fact).measures, [
			{
				name: "keel.hold",
				value: 1,
				attributes: {
					lane: "build",
					cause: outcome === "effect_failed" ? "failed" : outcome,
				},
			},
		]);
		const [ask] = b.asks();
		assert.equal(b.effects().length, 0);
		assert.match(ask!.basis, /build\/fix reports:/);
		assert.match(
			ask!.basis,
			new RegExp(outcome === "effect_failed" ? "read failed" : outcome),
		);
		b.resume("try another checkout");
		assert.notEqual(b.effect().key, first.key);
		if (outcome !== "occupied") {
			assert.deepEqual(b.effect().spec, first.spec);
			assert.match(ask!.basis, /same pinned/i);
		} else
			assert.notEqual(
				(b.effect().spec.op as JsonObject).path,
				(first.spec.op as JsonObject).path,
			);
		b.send({
			kind: "effect_done",
			key: first.key,
			result: { kind: "worktree", base: repo.trunkHead, principles: [] },
		});
		assert.equal(b.agents().length, 1);
		b.ready();
		assert.match(b.request("worker").text, /try another checkout/);
	});
}

function preparingBesidePublication() {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.workOn();
	b.briefItem("other");
	b.pub();
	return b;
}

// Read the move before and after recording the sibling merge; both must re-pin.
for (const order of ["merge first", "move first"]) {
	test(`${order}: a recorded merge explains the moved preparation without an owner decision`, () => {
		const b = preparingBesidePublication();
		const first = b.effect();
		const merge = () => b.send({ kind: "merged", item: "fix", head: merged });
		if (order === "merge first") merge();
		assert.deepEqual(
			b.done({ kind: "moved", actual: merged }, first.key).send ?? [],
			[],
		);
		if (order === "move first") {
			assert.deepEqual(b.effects(), []);
			assert.deepEqual(merge().send ?? [], []);
		}
		const next = b
			.effects()
			.find((e) => (e.spec.op as JsonObject).kind === "worktree")!;
		assert.notEqual(next.key, first.key);
		assert.notEqual(
			(next.spec.op as JsonObject).path,
			(first.spec.op as JsonObject).path,
		);
		assert.equal((next.spec.op as JsonObject).base, merged);
	});
}

test("a sibling merge at the wrong SHA or a failed review cannot explain a moved preparation", () => {
	for (const kind of ["merged", "rework"]) {
		const b = preparingBesidePublication();
		assert.deepEqual(b.done({ kind: "moved", actual: sha }).measures ?? [], []);
		const result = b.send({
			kind,
			item: "fix",
			head: merged,
			evidence: "conflict",
			threads: [],
		});
		assert.deepEqual(
			result.measures?.filter((m) => m.name === "keel.hold"),
			[
				{
					name: "keel.hold",
					value: 1,
					attributes: { lane: "build", cause: "moved" },
				},
			],
		);
		assert.equal(b.asks().length, 1);
		assert.match(b.asks()[0]!.basis, /build\/other reports:/);
		assert.match(b.asks()[0]!.basis, new RegExp(sha));
		assert.ok(
			!b.effects().some((e) => (e.spec.op as JsonObject).kind === "worktree"),
		);
	}
});

function replaceOccupied(b: ReturnType<typeof setup>) {
	const before = b.effect();
	b.done({ kind: "occupied", path: "/foreign" });
	b.resume();
	return before.spec.op as JsonObject;
}

test("only the confirmed replacement releases all its own old attempts for unmerged cleanup", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.briefItem();
	const first = replaceOccupied(b);
	const second = replaceOccupied(b);
	const replacement = b.effect();
	b.briefItem("other");
	const sibling = b.effects().find((e) => e.key !== replacement.key)!;
	const confirm = (key: string) =>
		b.send({
			kind: "effect_done",
			key,
			result: { kind: "worktree", base: repo.trunkHead, principles: [] },
		});
	confirm(sibling.key);
	assert.deepEqual(b.effects(), [replacement]);
	confirm(replacement.key);
	assert.deepEqual(
		b.effects().map((e) => (e.spec.op as JsonObject).target),
		[first, second],
	);
	assert.ok(
		b.effects().every((e) => (e.spec.op as JsonObject).merged !== true),
	);
	const kept = b.done({ kind: "kept", reason: "private", files: ["scratch"] });
	assert.match(JSON.stringify(kept.notes), /worker-fix-1.*scratch/);
	const lost = b.send({
		kind: "effect_failed",
		key: b.effect().key,
		error: "lost registration",
	});
	assert.match(JSON.stringify(lost.notes), /worker-fix-2.*lost registration/);
	assert.ok(b.agent("worker").expect?.tools.includes("publish_build"));
	b.send({ kind: "cancel" });
	assert.deepEqual(
		b.effects().map((e) => (e.spec.op as JsonObject).target),
		[replacement.spec.op, sibling.spec.op],
	);
	b.done({ kind: "removed" });
	const final = b.done({ kind: "removed" }).send?.[0]?.event;
	assert.match(JSON.stringify(final?.kept), /scratch.*lost registration/);
});

for (const confirmed of [false, true]) {
	test(`cancel drains both attempts ${confirmed ? "during old checkout cleanup" : "before replacement confirmation"}`, () => {
		const b = setup();
		b.prepare();
		const old = replaceOccupied(b);
		const replacement = b.effect();
		if (confirmed) b.ready();
		const claimed = b.effect();
		Object.assign(b.world, {
			runningEffect: (key: string) => key === claimed.key,
		});
		b.send({ kind: "cancel" });
		const removal = b
			.effects()
			.find(
				(e) =>
					((e.spec.op as JsonObject).target as JsonObject).path === old.path,
			)!;
		assert.deepEqual((removal.spec.op as JsonObject).target, old);
		if (confirmed) assert.equal(removal.key, claimed.key);
		assert.deepEqual(
			b.send({
				kind: "effect_done",
				key: removal.key,
				result: { kind: "removed" },
			}).send ?? [],
			[],
		);
		if (!confirmed) {
			assert.deepEqual(b.effects(), []);
			b.send({
				kind: "effect_done",
				key: claimed.key,
				result: { kind: "worktree", principles: [] },
			});
		}
		assert.deepEqual(
			(b.effect().spec.op as JsonObject).target,
			replacement.spec.op,
		);
		assert.equal(
			b.done({ kind: "removed" }).send![0]!.event.kind,
			"cleanup_finished",
		);
	});
}

test("a discovery resumed after bad options reads the current base and trunk", () => {
	const b = setup();
	b.send({ kind: "bound", mandate });
	b.send({ kind: "effect_failed", key: b.effect().key, error: "missing base" });
	assert.match(b.asks()[0]!.basis, /missing base/);
	Object.assign(b.world.options, { base: "stable", trunk: "release" });
	b.resume("retry");
	assert.deepEqual(b.effect().spec, {
		kind: "read_repo",
		base: "stable",
		trunk: "release",
	});
});

test("only an attributed trunk move refreshes a start plan, and the refreshed snapshot must still match", () => {
	for (const race of [false, true]) {
		const b = setup();
		b.send({ kind: "bound", mandate });
		b.done({ kind: "repo", repo });
		const old = b.effect();
		const refresh = b.done({ kind: "moved", actual: merged, keelMoved: true });
		assert.equal(refresh.send?.length ?? 0, 0);
		assert.equal(b.effect().spec.kind, "read_repo");
		const snapshot = { ...repo, trunkHead: race ? sha : merged };
		b.done({ kind: "repo", repo: snapshot });
		if (race) {
			// Replay the original start so repo must attribute this second move too.
			assert.deepEqual(b.effect().spec, old.spec);
			b.done({ kind: "moved", actual: sha });
			assert.match(b.asks()[0]!.basis, /same pinned/i);
			assert.deepEqual(b.effects(), []);
		} else {
			assert.notEqual(
				(b.effect().spec.op as JsonObject).key,
				(old.spec.op as JsonObject).key,
			);
			assert.deepEqual(b.effect().spec.repo, snapshot);
		}
	}
});

test("a start that failed after a possible CAS keeps its immutable git plan on explicit retry", () => {
	const b = setup();
	b.send({ kind: "bound", mandate });
	b.done({ kind: "repo", repo });
	const first = b.effect();
	b.send({ kind: "effect_failed", key: first.key, error: "lost CAS response" });
	assert.match(b.asks()[0]!.basis, /lost CAS response/);
	b.resume("retry the pinned plan");
	assert.notEqual(b.effect().key, first.key);
	assert.deepEqual(b.effect().spec, first.spec);
});

for (const role of ["coordinator", "worker"]) {
	test(`${role} stop holds once, resume delivers new direction, and cancel retires the turn`, () => {
		const b = setup();
		if (role === "worker") b.working();
		else b.start();
		const stop = () => ({
			kind: "agent_stalled",
			agent: b.agent(role).key,
			token: b.request(role).token,
			cause: "stopped",
			lastWords: "need review",
		});
		const old = stop();
		b.send(old);
		assert.equal(b.agent(role).paused, true);
		assert.match(b.asks()[0]!.basis, /stopped[\s\S]*need review/);
		assert.deepEqual(b.send(old).send ?? [], []);
		b.resume("continue now");
		assert.notEqual(b.request(role).token, old.token);
		assert.deepEqual(b.send(old).send ?? [], []);
		assert.match(b.request(role).text, /continue now/);
		if (role === "coordinator") {
			b.send({ kind: "plan", items: [item] });
			assert.doesNotMatch(b.request(role).text, /continue now/);
		}
		b.send(stop());
		assert.equal(
			b.send(holdingChoice(b.asks()[0]!, "cancel")).send?.[0]?.event.kind,
			"cancel_work",
		);
		b.send({ kind: "cancel" });
		if (role === "worker") {
			assert.equal((b.effect().spec.op as JsonObject).kind, "remove");
			b.done({ kind: "removed" });
		}
		assert.deepEqual(b.effects(), []);
		assert.deepEqual(b.agents(), []);
	});
}

test("cancel gathers all worker cleanup outcomes into one completion, including held and in-flight attempts", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "second" }]);
	b.briefItem();
	const held = b.effect();
	b.send({
		kind: "effect_failed",
		key: held.key,
		error: "interrupted after worktree add",
	});
	b.briefItem("second");
	const running = b.effect();
	Object.assign(b.world, {
		runningEffect: (key: string) => key === running.key,
	});
	assert.equal(b.send({ kind: "cancel" }).send?.length ?? 0, 0);
	assert.deepEqual(b.agents(), []);
	assert.equal(b.effects().length, 1);
	const op = b.effect().spec.op as JsonObject;
	assert.equal(op.kind, "remove");
	assert.deepEqual(op.target, held.spec.op);
	assert.notEqual(op.merged, true);
	assert.equal(
		b.done({ kind: "kept", reason: "private", files: ["scratch"] }).send
			?.length ?? 0,
		0,
	);
	assert.deepEqual(b.effects(), []);
	b.send({
		kind: "effect_done",
		key: running.key,
		result: { kind: "worktree", base: repo.trunkHead, principles: [] },
	});
	assert.deepEqual((b.effect().spec.op as JsonObject).target, running.spec.op);
	const final = b.send({
		kind: "effect_failed",
		key: b.effect().key,
		error: "lost registration",
	}).send!;
	assert.equal(final.length, 1);
	assert.equal(final[0]!.lane, "design");
	assert.equal(final[0]!.event.kind, "cleanup_finished");
	assert.equal(final[0]!.event.lane, "build");
	const kept = JSON.stringify(final[0]!.event.kept);
	for (const evidence of [
		"worker-fix-1",
		"scratch",
		"worker-second-1",
		"lost registration",
	])
		assert.ok(kept.includes(evidence));
	assert.deepEqual(b.effects(), []);
	assert.equal(b.send({ kind: "cancel" }).send?.length ?? 0, 0);
});

test("cancel without a worker acknowledges completion; unclaimed worktree creation never starts", () => {
	const empty = setup();
	assert.deepEqual(empty.send({ kind: "cancel" }).send, [
		{
			lane: "design",
			work,
			event: { kind: "cleanup_finished", lane: "build", kept: [] },
		},
	]);
	const b = setup();
	b.prepare();
	const pending = b.effect();
	b.send({ kind: "cancel" });
	assert.ok(
		b
			.effects()
			.every(
				(e) =>
					e.key !== pending.key && (e.spec.op as JsonObject).kind === "remove",
			),
	);
});

test("a claimed start may still create a ref; cancel waits for that exact result, never opening planning", () => {
	const b = setup();
	b.send({ kind: "bound", mandate });
	b.done({ kind: "repo", repo });
	const start = b.effect();
	Object.assign(b.world, { runningEffect: (key: string) => key === start.key });
	assert.equal(b.send({ kind: "cancel" }).send?.length ?? 0, 0);
	assert.deepEqual(b.effects(), []);
	assert.equal(
		b.send({ kind: "effect_failed", key: "stale", error: "unrelated" }).send
			?.length ?? 0,
		0,
	);
	assert.deepEqual(
		b.send({
			kind: "effect_done",
			key: start.key,
			result: { kind: "started", base: repo.trunkHead },
		}).send,
		[
			{
				lane: "design",
				work,
				event: { kind: "cleanup_finished", lane: "build", kept: [] },
			},
		],
	);
	assert.deepEqual(b.agents(), []);
});

test("cancel drains an existing removal exactly once and includes an earlier kept worker", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.workOn();
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	b.done({ kind: "kept", reason: "private", files: ["before-cancel"] });
	b.workOn("other", merged);
	b.pub();
	b.send({ kind: "merged", item: "other", head: sha });
	const active = b.effect();
	Object.assign(b.world, {
		runningEffect: (key: string) => key === active.key,
	});
	b.send({ kind: "cancel" });
	const retried = b.effects().find((e) => e.key !== active.key)!;
	assert.equal((retried.spec.op as JsonObject).mergedHead, merged);
	b.send({
		kind: "effect_done",
		key: retried.key,
		result: { kind: "kept", reason: "private", files: ["before-cancel"] },
	});
	const completion = b.send({
		kind: "effect_done",
		key: active.key,
		result: { kind: "removed" },
	}).send![0]!.event;
	assert.match(JSON.stringify(completion.kept), /before-cancel/);
	assert.deepEqual(b.effects(), []);
});

test("merge authorizes cleanup; kept private files are reported and the coordinator hands off the verified head", () => {
	const b = setup();
	b.working();
	b.send({ kind: "ruling", agent: b.agent("worker").key, ruling });
	assert.deepEqual(b.pub().measures ?? [], []);
	assert.deepEqual(
		b.send({ kind: "merged", item: "fix", head: merged }).measures,
		[{ name: "keel.item.attempts", value: 1, attributes: { kind: "build" } }],
	);
	const op = b.effect().spec.op as JsonObject;
	assert.equal(op.kind, "remove");
	assert.equal(op.merged, true);
	assert.equal(op.mergedHead, merged);
	assert.equal(
		(op.target as JsonObject).path,
		"/repo/.git/keel/32/worker-fix-1",
	);
	b.done({ kind: "occupied", path: "private path" });
	assert.match(b.asks()[0]!.basis, /private path/);
	assert.equal(b.agent("coordinator").expect, null);
	assert.deepEqual(b.effects(), []);
	b.resume("leave my notes intact");
	assert.deepEqual(b.effect().spec.op, op);
	const cleanup = b.done({
		kind: "kept",
		files: ["private"],
		reason: "untracked",
	});
	assert.deepEqual(cleanup.measures ?? [], []);
	assert.match(JSON.stringify(cleanup.notes), /private/);
	assert.match(b.request("coordinator").text, /leave my notes intact/);
	const h = b.send({
		kind: "handoff",
		summary: "price repaired",
		risk: "tick table",
	}).send![0]!;
	assert.deepEqual(h, {
		lane: "verify",
		work,
		event: {
			kind: "handoff",
			repo,
			head: merged,
			base: repo.trunkHead,
			mandate,
			rulings: [ruling],
			summary: "price repaired",
			risk: "tick table",
			approvals: [],
		},
	});
	b.send({ kind: "closed" });
	assert.deepEqual(b.agents(), []);
});

test("full-set or trunk returns request a new correction on the merged head, not a rewrite", () => {
	for (const kind of ["rework", "integration"]) {
		const b = setup();
		b.working();
		b.pub();
		b.send({ kind: "merged", item: "fix", head: merged });
		b.done({ kind: "removed" });
		b.send({ kind: "handoff", summary: "price repaired", risk: "tick" });
		const head = kind === "rework" ? "e".repeat(40) : merged;
		b.send({
			kind,
			item: "full",
			head,
			...(kind === "integration" ? { inheritedTrunk: sha } : {}),
			direction: "choose two small probes",
			threads: ["precision"],
			evidence: "the tick grid changed",
		});
		const req = b.request("coordinator");
		assert.deepEqual(req.tools, ["publish_plan"]);
		assert.match(req.text, /the tick grid changed/);
		assert.match(req.text, /publish_plan/);
		assert.match(req.text, /choose two small probes/);
		if (kind === "integration") assert.ok(req.text.includes(sha));
		assert.ok("reject" in b.tryEvent({ kind: "plan", items: [item] }));
		b.send({
			kind: "plan",
			items: [{ ...item, id: "correction", deps: ["fix"] }],
		});
		assert.match(b.request("coordinator").text, /precision/);
		assert.doesNotMatch(
			b.request("coordinator").text,
			/choose two small probes/,
		);
		b.briefItem("correction");
		assert.equal((b.effect().spec.op as JsonObject).base, head);
		b.done({ kind: "worktree", base: head, principles: [] });
		assert.match(b.request("worker").text, /precision/);
		assert.partialDeepStrictEqual(b.publication(), {
			inheritedTrunk: kind === "integration" ? sha : null,
		});
		assert.deepEqual(
			b.pub(undefined, ["precision"]).send![0]!.event.addresses,
			["precision"],
		);
		b.send({
			kind: "rework",
			item: "correction",
			evidence: "item probe failed",
			threads: ["negative"],
		});
		assert.match(b.request("worker").text, /precision/);
		assert.ok(
			"reject" in
				b.tryEvent({
					kind: "publish",
					agent: b.agent("worker").key,
					summary: "invented",
					addresses: ["invented"],
					facts: clean,
				}),
		);
		assert.deepEqual(
			b.pub(undefined, ["precision", "negative"]).send![0]!.event.addresses,
			["precision", "negative"],
		);
	}
});
