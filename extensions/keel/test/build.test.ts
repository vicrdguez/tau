import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId, JsonObject } from "tau/durable";
import { workId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { buildLane, buildTools } from "../src/lanes/build/index.ts";

const mandate = {
	intent: "repair pricing",
	nodes: [{ label: "price", rule: "round once", probe: "0.05" }],
	protectedPaths: ["tests/**"],
	checks: [{ id: "prove", argv: ["make", "test"], timeoutMs: 5000 }],
};
const work = workId(32 as ConversationId);
const root = "/repo";
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
	fences: "pricing only",
	nodes: ["price"],
};
const ruling = {
	what: "integer",
	why: "exact",
	cost: "migration",
	rank: 2,
	follows: "existing price model",
};
const item = { id: "fix", kind: "build", goal: "fix rounding", deps: [] };
function setup(max_workers = 1) {
	const world: World = {
		work,
		root,
		now: 0,
		view: () => null,
		options: {
			design: "a/a",
			verify: "b/b",
			queue: "c/c",
			build: "d/d",
			base: "main",
			trunk: "trunk",
			max_workers,
		},
	};
	return buildLane.use((lane) => {
		let s = lane.state.initial();
		const tryEvent = (e: LaneEvent) => lane.reduce(s, e, world);
		function send(e: LaneEvent) {
			const result = tryEvent(e);
			if ("reject" in result) assert.fail(result.reject);
			s = result.state;
			return result;
		}
		const agents = () => lane.agents(s, world);
		const agent = (role: string) => {
			const a = agents().find((a) => a.role === role);
			assert.ok(a);
			return a;
		};
		const effects = () => lane.effects(s, world);
		const effect = () => {
			const e = effects()[0];
			assert.ok(e);
			return e;
		};
		const done = (result: JsonObject) =>
			send({ kind: "effect_done", key: effect().key, result });
		function start() {
			send({ kind: "bound", mandate });
			assert.deepEqual(effect().spec, {
				kind: "read_repo",
				base: "main",
				trunk: "trunk",
			});
			assert.deepEqual(agents(), []);
			done({ kind: "repo", repo });
			const { op } = effect().spec;
			assert.deepEqual(op, {
				kind: "start_build",
				key: effect().key,
				branch: "keel/32/build",
			});
			assert.deepEqual(agents(), []);
			done({ kind: "started", base: repo.trunkHead });
		}
		function plan(items: JsonObject[] = [item]) {
			start();
			send({ kind: "plan", items });
		}
		function prepare(kind = "build") {
			plan([{ ...item, kind }]);
			send({ kind: "brief", ...brief });
		}
		function working(kind = "build") {
			prepare(kind);
			done({ kind: "worktree", base: repo.trunkHead, principles: [] });
		}
		const pub = (
			facts: JsonObject = { kind: "ok", sha, touched: [] },
			addresses: string[] = [],
		) =>
			send({
				kind: "publish",
				agent: agent("worker").key,
				summary: "patched",
				addresses,
				facts,
			});
		const request = (role: string) => {
			const exp = agent(role).expects[0];
			assert.ok(exp?.input);
			return { token: exp.token, tools: exp.tools, text: exp.input() };
		};
		return {
			start,
			plan,
			prepare,
			working,
			pub,
			tryEvent,
			send,
			done,
			agents,
			agent,
			request,
			effects,
			effect,
			identity: [lane.state.kind, lane.state.version, lane.state.scope],
		};
	});
}

test("Build v1 discovers the repo and starts the build before opening planning", () => {
	const b = setup();
	assert.deepEqual(b.identity, ["keel.build", 1, "conversation"]);
	b.start();
	const r = b.request("coordinator");
	assert.deepEqual(r.tools, ["publish_plan"]);
	assert.match(r.text, /repair pricing/);
});

test("plans refuse unsafe or duplicate IDs, empty plans, missing dependencies and cycles", () => {
	const b = setup();
	b.start();
	for (const items of [
		[],
		[item, item],
		[{ ...item, id: "../a" }],
		[{ ...item, id: "full" }],
		[{ ...item, deps: ["later"] }],
		[{ ...item, deps: ["fix"] }],
		[
			{ ...item, deps: ["next"] },
			{ ...item, id: "next", deps: ["fix"] },
		],
	])
		assert.ok("reject" in b.tryEvent({ kind: "plan", items }));
	assert.deepEqual(b.effects(), []);
});

test("briefs require ready work and bound labels; only a confirmed worktree starts a worker", () => {
	const b = setup();
	b.plan([item, { ...item, id: "later", deps: ["fix"] }]);
	for (const e of [
		{ kind: "brief", ...brief, item: "later" },
		{ kind: "brief", ...brief, nodes: ["unknown"] },
		{ kind: "brief", ...brief, nodes: [] },
		{ kind: "handoff", summary: "done", risk: "none" },
	])
		assert.ok("reject" in b.tryEvent(e));
	b.send({ kind: "brief", ...brief });
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
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
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
	b.send({ kind: "brief", ...brief });
	assert.match(b.request("coordinator").text, /other/);
	b.send({ kind: "brief", ...brief, item: "other" });
	assert.equal(b.agent("coordinator").expects.length, 0);
	assert.equal(b.effects().length, 2);
});

test("dirty and unrelated work cannot publish, and the tool offers no SHA argument", () => {
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
	const tool = buildTools.find((t) => t.name === "publish_build")!;
	assert.equal(tool.observes, true);
	const schema = tool.build(async () => ({ output: [] })).parameters;
	assert.ok(
		"properties" in schema &&
			schema.properties &&
			typeof schema.properties === "object",
	);
	assert.deepEqual(Object.keys(schema.properties).sort(), [
		"addresses",
		"summary",
	]);
});

test("a protected path holds an ordinary item; direction reaches the worker but does not waive protection", () => {
	const b = setup();
	b.working();
	const touched = { kind: "ok", sha, touched: ["tests/round"] };
	const filed = b.pub(touched).send!;
	assert.equal(filed.length, 1);
	const f = filed[0]!;
	assert.deepEqual(
		[f.lane, f.work, f.event.kind, f.event.item, f.event.lane, f.event.work],
		["queue", null, "file", "fix", "build", work],
	);
	assert.match(String(f.event.evidence), /tests\/round/);
	assert.equal(b.agent("worker").paused, true);
	b.send({
		kind: "resume",
		item: "fix",
		cause: "old",
		direction: "go",
		evidence: "",
	});
	assert.equal(b.agent("worker").paused, true);
	b.send({
		kind: "resume",
		item: "fix",
		cause: f.event.cause!,
		direction: "restore fixture",
		evidence: f.event.evidence!,
	});
	assert.match(b.request("worker").text, /restore fixture/);
	assert.match(b.request("worker").text, /tests\/round/);
	const again = b.pub(touched).send![0]!;
	assert.equal(again.lane, "queue");
	assert.notEqual(again.event.cause, f.event.cause);
	const encode = setup();
	encode.working("encode");
	assert.equal(encode.pub(touched).send![0]!.lane, "verify");
});

test("rework and integration reach the original worker with fresh expectations; only observed publications advance", () => {
	const b = setup();
	b.working();
	const worker = b.agent("worker");
	b.send({ kind: "ruling", agent: worker.key, ruling });
	const first = b.pub().send![0]!;
	assert.equal(first.lane, "verify");
	assert.equal(first.event.kind, "published");
	assert.deepEqual(first.event.rulings, [ruling]);
	assert.equal(first.event.sha, sha);
	assert.equal(first.event.head, repo.trunkHead);
	assert.match(String(first.event.brief), /works at ties/);
	let prev = worker.expects[0]!.token;
	for (const [kind, evidence] of [
		["rework", "wrong rounding"],
		["integration", "merge conflict in book"],
		["integration", "proof failed: invalid tick"],
	] as const) {
		b.send({ kind, item: "fix", evidence, threads: ["tie"] });
		assert.equal(b.agent("worker").key, worker.key);
		const req = b.request("worker");
		assert.ok(req.text.includes(evidence));
		assert.match(req.text, /tie/);
		assert.notEqual(req.token, prev);
		prev = req.token;
		assert.deepEqual(b.pub(undefined, ["tie"]).send![0]!.event.addresses, [
			"tie",
		]);
	}
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
		const file = b.send(fact).send![0]!.event;
		assert.equal(file.item, "fix");
		assert.equal(b.effects().length, 0);
		assert.match(
			String(file.evidence),
			new RegExp(outcome === "effect_failed" ? "read failed" : outcome),
		);
		b.send({
			kind: "resume",
			item: "fix",
			cause: file.cause!,
			evidence: file.evidence!,
			direction: "try another checkout",
		});
		assert.notEqual(b.effect().key, first.key);
		if (outcome !== "occupied") assert.deepEqual(b.effect().spec, first.spec);
		else
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
		b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
		assert.match(b.request("worker").text, /try another checkout/);
	});
}

test("a start that failed after a possible CAS keeps its immutable git plan on explicit retry", () => {
	const b = setup();
	b.send({ kind: "bound", mandate });
	b.done({ kind: "repo", repo });
	const first = b.effect();
	const f = b.send({
		kind: "effect_failed",
		key: first.key,
		error: "lost CAS response",
	}).send![0]!.event;
	b.send({
		kind: "resume",
		cause: f.cause!,
		item: null,
		evidence: f.evidence!,
		direction: "retry the pinned plan",
	});
	assert.notEqual(b.effect().key, first.key);
	assert.deepEqual(b.effect().spec, first.spec);
});

test("stop holds the current turn, resume redelivers direction, and cancellation retires both agents", () => {
	for (const role of ["worker", "coordinator"]) {
		const b = setup();
		if (role === "worker") b.working();
		else b.start();
		const old = b.request(role);
		const stop = () =>
			b.send({
				kind: "agent_stalled",
				agent: b.agent(role).key,
				tokens: [b.request(role).token],
				cause: "stopped",
				lastWords: "need review",
			}).send![0]!.event;
		const file = stop();
		assert.match(String(file.evidence), /stopped/);
		assert.match(String(file.evidence), /need review/);
		assert.equal(b.agent(role).paused, true);
		b.send({
			kind: "resume",
			item: file.item!,
			cause: file.cause!,
			direction: "continue now",
			evidence: file.evidence!,
		});
		assert.match(b.request(role).text, /continue now/);
		assert.notEqual(b.request(role).token, old.token);
		stop();
		b.send({ kind: "cancel" });
		assert.deepEqual(b.agents(), []);
		assert.deepEqual(b.effects(), []);
		b.send({
			kind: "effect_done",
			key: "late",
			result: { kind: "started", base: repo.trunkHead },
		});
		assert.deepEqual(b.agents(), []);
	}
});

test("merge authorizes cleanup; kept private files are reported and the coordinator hands off the verified head", () => {
	const b = setup();
	b.working();
	b.send({ kind: "ruling", agent: b.agent("worker").key, ruling });
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	const op = b.effect().spec.op as JsonObject;
	assert.equal(op.kind, "remove");
	assert.equal(op.merged, true);
	assert.equal(
		(op.target as JsonObject).path,
		"/repo/.git/keel/32/worker-fix-1",
	);
	assert.match(
		JSON.stringify(
			b.done({ kind: "kept", files: ["private"], reason: "untracked" }).notes,
		),
		/private/,
	);
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
			threads: ["precision"],
			evidence: "the tick grid changed",
		});
		const req = b.request("coordinator");
		assert.deepEqual(req.tools, ["publish_plan"]);
		assert.match(req.text, /the tick grid changed/);
		assert.ok("reject" in b.tryEvent({ kind: "plan", items: [item] }));
		b.send({
			kind: "plan",
			items: [{ ...item, id: "correction", deps: ["fix"] }],
		});
		b.send({ kind: "brief", ...brief, item: "correction" });
		assert.equal((b.effect().spec.op as JsonObject).base, head);
	}
});
