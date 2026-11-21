import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId, JsonObject } from "tau/durable";
import { workId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { buildLane, buildTools } from "../src/lanes/build/index.ts";
import type { Mandate } from "../src/lanes/design/public.ts";
import { drive } from "./fixtures/drive.ts";

const mandate: Mandate = {
	delegated: [],
	encodeRequired: false,
	approvalNotes: [] as string[],
	intent: "repair pricing",
	nodes: [{ label: "price", rule: "round once", probe: "0.05" }],
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
const item = { id: "fix", kind: "build", goal: "fix rounding", deps: [] };
const clean = {
	kind: "ok",
	sha,
	base: repo.trunkHead,
	changedPolicyFiles: [],
};
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
		const tryEvent = (e: LaneEvent) => drive(lane, s, e, world);
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
		function start(bound: Mandate = mandate) {
			send({
				kind: "bound",
				mandate: bound,
			});
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
		const pub = (facts: JsonObject = clean, addresses: string[] = []) =>
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
			world,
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

const reviewed: Mandate = {
	...mandate,
	encodeRequired: true,
	approvalNotes: ["Cover cash ties", "Keep the integer seam"],
	delegated: [{ label: "tick-order", text: "Choose tick order locally" }],
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
	const first = b.send({ kind: "plan", items: [encode], replies });
	assert.deepEqual(first.state.approvalReplies, replies);
	assert.ok(
		"reject" in b.tryEvent({ kind: "brief", ...brief, nodes: ["tick-order"] }),
	);
	b.send({ kind: "brief", ...brief, nodes: ["cash-port", "port-api"] });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
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
	assert.deepEqual(handoff.send?.[0]?.event.approvalReplies, replies);
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
	assert.deepEqual(correction.state.approvalReplies, replies);
});

test("reviewed work without seams or rules can start with ordinary work", () => {
	const b = setup();
	b.start({ ...reviewed, encodeRequired: false, approvalNotes: [] });
	b.send({ kind: "plan", items: [item] });
	assert.deepEqual(b.request("coordinator").tools, ["brief_item"]);
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

test("principle and playbook changes go to the verifier without a publication hold", () => {
	const b = setup();
	b.working();
	const changedPolicyFiles = [
		".keel/principles/round.md",
		".keel/playbooks/check.md",
	];
	const result = b.pub({ ...clean, changedPolicyFiles });
	assert.equal(result.send?.length, 1);
	assert.equal(result.send?.[0]?.lane, "verify");
	assert.deepEqual(
		result.send?.[0]?.event.changedPolicyFiles,
		changedPolicyFiles,
	);
	assert.equal(b.agent("worker").paused, false);
});

test("a prose fence is refused before any worktree is prepared", () => {
	const b = setup();
	b.plan();
	const result = b.tryEvent({
		kind: "brief",
		...brief,
		fences: "book.sh and book-check.sh",
	});
	assert.ok("reject" in result);
	assert.match(result.reject, /fence.*repository.relative path/i);
	assert.deepEqual(b.effects(), []);
});

test("worker input passes the item's path fences and triggers a premise check only for a survived fix", () => {
	const b = setup();
	b.plan();
	b.send({
		kind: "brief",
		...brief,
		fences: "./src/money/./tick.ts\n\n tests/tie.ts ",
	});
	const policy = [
		{
			name: "money",
			body: "---\ndescription: Use whole cents.\n---\nPin cents at this base.",
		},
	];
	b.done({ kind: "worktree", base: repo.trunkHead, principles: policy });
	const expectation = () => b.agent("worker").expects[0]!;
	assert.deepEqual(expectation().paths, ["src/money/tick.ts", "tests/tie.ts"]);
	assert.notEqual(expectation().situation, "survived_fix");
	assert.deepEqual(expectation().projectPrinciples, policy);
	assert.deepEqual(b.pub().send![0]!.event.paths, [
		"src/money/tick.ts",
		"tests/tie.ts",
	]);
	const back = {
		kind: "rework",
		item: "fix",
		evidence: "wrong at ties",
		threads: ["tie"],
	};
	b.send(back);
	assert.notEqual(expectation().situation, "survived_fix");
	b.pub(undefined, ["tie"]);
	b.send(back);
	assert.equal(expectation().situation, "survived_fix");
	assert.deepEqual(expectation().projectPrinciples, policy);
	assert.deepEqual(expectation().paths, ["src/money/tick.ts", "tests/tie.ts"]);
	b.pub(undefined, ["tie"]);
	b.send({ ...back, kind: "integration" });
	assert.notEqual(expectation().situation, "survived_fix");
});

test("the verifier receives the repo's comparison base, not the current head or original attempt base", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.send({ kind: "brief", ...brief });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
	b.send({ kind: "brief", ...brief, item: "other" });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	const inherited = "f".repeat(40);
	const p = b.pub({ ...clean, base: inherited }).send![0]!.event;
	assert.equal(p.head, merged);
	assert.equal(p.base, inherited);
	assert.equal(p.trunk, null);
});

test("rework and integration reach the original worker with fresh expectations; only observed publications advance", () => {
	const b = setup();
	b.working();
	const worker = b.agent("worker");
	const cited = { ...ruling, principles: ["prove-it-works"] };
	b.send({ kind: "ruling", agent: worker.key, ruling: cited });
	const first = b.pub().send![0]!;
	assert.equal(first.lane, "verify");
	assert.equal(first.event.kind, "published");
	assert.deepEqual(first.event.rulings, [cited]);
	assert.equal(first.event.sha, sha);
	assert.equal(first.event.head, repo.trunkHead);
	assert.match(String(first.event.brief), /works at ties/);
	assert.match(String(first.event.brief), /patched/);
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
		if (outcome !== "occupied") {
			assert.deepEqual(b.effect().spec, first.spec);
			assert.match(String(file.resume), /same pinned/i);
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
		b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
		assert.match(b.request("worker").text, /try another checkout/);
	});
}

test("a worker racing a recorded merge is prepared from the new head without owner intervention", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.send({ kind: "brief", ...brief });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
	b.send({ kind: "brief", ...brief, item: "other" });
	const original = b.effect();
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	const result = b.send({
		kind: "effect_done",
		key: original.key,
		result: { kind: "moved", actual: merged },
	});
	assert.equal(result.send?.length ?? 0, 0);
	const next = b
		.effects()
		.find((e) => (e.spec.op as JsonObject).kind === "worktree")!;
	assert.notEqual(next.key, original.key);
	assert.notEqual(
		(next.spec.op as JsonObject).path,
		(original.spec.op as JsonObject).path,
	);
	assert.equal((next.spec.op as JsonObject).base, merged);
});

function preparingBesidePublication() {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.send({ kind: "brief", ...brief });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
	b.send({ kind: "brief", ...brief, item: "other" });
	b.pub();
	return b;
}

test("a later-recorded merge explains a moved preparation without filing a finding", () => {
	const b = preparingBesidePublication();
	const first = b.effect();
	assert.deepEqual(b.done({ kind: "moved", actual: merged }).send ?? [], []);
	assert.deepEqual(b.effects(), []);
	assert.deepEqual(
		b.send({ kind: "merged", item: "fix", head: merged }).send ?? [],
		[],
	);
	const next = b
		.effects()
		.find((e) => (e.spec.op as JsonObject).kind === "worktree")!;
	assert.notEqual(
		(next.spec.op as JsonObject).key,
		(first.spec.op as JsonObject).key,
	);
	assert.equal((next.spec.op as JsonObject).base, merged);
});

for (const kind of ["merged", "rework", "integration"]) {
	test(`a sibling's ${kind} that cannot explain a moved preparation files the observed head`, () => {
		const b = preparingBesidePublication();
		b.done({ kind: "moved", actual: sha });
		const files = b.send({
			kind,
			item: "fix",
			head: merged,
			evidence: "conflict",
			threads: [],
		}).send;
		assert.equal(files?.length, 1);
		assert.equal(files[0]!.event.item, "other");
		assert.match(String(files[0]!.event.evidence), new RegExp(sha));
		assert.ok(
			!b.effects().some((e) => (e.spec.op as JsonObject).kind === "worktree"),
		);
	});
}

function replaceOccupied(b: ReturnType<typeof setup>) {
	const before = b.effect();
	const hold = b.done({ kind: "occupied", path: "/foreign" }).send![0]!.event;
	b.send({
		kind: "resume",
		cause: hold.cause!,
		item: hold.item!,
		evidence: hold.evidence!,
		direction: "",
	});
	return before.spec.op as JsonObject;
}

test("only the confirmed replacement releases all its own old attempts for unmerged cleanup", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "other" }]);
	b.send({ kind: "brief", ...brief });
	const first = replaceOccupied(b);
	const second = replaceOccupied(b);
	const replacement = b.effect();
	b.send({ kind: "brief", ...brief, item: "other" });
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
	b.done({ kind: "removed" });
	b.done({ kind: "removed" });
	b.send({ kind: "cancel" });
	assert.deepEqual(
		b.effects().map((e) => (e.spec.op as JsonObject).target),
		[replacement.spec.op, sibling.spec.op],
	);
});

for (const denied of ["kept", "effect_failed"]) {
	test(`an old attempt's ${denied} cleanup reports the path without holding the replacement`, () => {
		const b = setup();
		b.prepare();
		const old = replaceOccupied(b);
		b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
		const key = b.effect().key;
		const outcome = b.send(
			denied === "kept"
				? {
						kind: "effect_done",
						key,
						result: { kind: "kept", reason: "private", files: ["scratch"] },
					}
				: { kind: "effect_failed", key, error: "lost registration" },
		);
		const evidence = denied === "kept" ? "scratch" : "lost registration";
		assert.ok(
			outcome.notes?.some(
				(n) => n.text.includes(String(old.path)) && n.text.includes(evidence),
			),
		);
		assert.deepEqual(b.request("worker").tools, ["publish_build"]);
		b.send({ kind: "cancel" });
		const final = b.done({ kind: "removed" }).send![0]!.event;
		assert.match(JSON.stringify(final.kept), new RegExp(evidence));
	});
}

for (const confirmed of [false, true]) {
	test(`cancel drains both attempts ${confirmed ? "during old checkout cleanup" : "before replacement confirmation"}`, () => {
		const b = setup();
		b.prepare();
		const old = replaceOccupied(b);
		const replacement = b.effect();
		if (confirmed)
			b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
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
	const failure = b.send({
		kind: "effect_failed",
		key: b.effect().key,
		error: "missing base",
	}).send![0]!.event;
	Object.assign(b.world.options, { base: "stable", trunk: "release" });
	b.send({
		kind: "resume",
		item: null,
		cause: failure.cause!,
		direction: "retry",
		evidence: failure.evidence!,
	});
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
			const held = b.done({ kind: "moved", actual: sha }).send![0]!.event;
			assert.match(String(held.resume), /same pinned/i);
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

test("a stopped token files only one finding and its direction is consumed by the resumed turn", () => {
	const b = setup();
	b.start();
	const old = b.request("coordinator");
	const stop = {
		kind: "agent_stalled",
		agent: b.agent("coordinator").key,
		tokens: [old.token],
		cause: "stopped",
		lastWords: "",
	};
	const file = b.send(stop).send![0]!.event;
	assert.equal(b.send(stop).send?.length ?? 0, 0);
	b.send({
		kind: "resume",
		item: null,
		cause: file.cause!,
		direction: "one small item",
		evidence: "",
	});
	assert.equal(b.send(stop).send?.length ?? 0, 0);
	assert.match(b.request("coordinator").text, /one small item/);
	b.send({ kind: "plan", items: [item] });
	assert.doesNotMatch(b.request("coordinator").text, /one small item/);
	b.send({ kind: "brief", ...brief });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
	b.pub();
	b.send({
		kind: "integration",
		item: "fix",
		evidence: "merge conflict",
		threads: [],
	});
	assert.doesNotMatch(b.request("worker").text, /Threads:\s*\n/i);
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
		if (role === "worker") {
			assert.equal((b.effect().spec.op as JsonObject).kind, "remove");
			b.done({ kind: "removed" });
		}
		assert.deepEqual(b.effects(), []);
		b.send({
			kind: "effect_done",
			key: "late",
			result: { kind: "started", base: repo.trunkHead },
		});
		assert.deepEqual(b.agents(), []);
	}
});

test("cancel gathers all worker cleanup outcomes into one completion, including held and in-flight attempts", () => {
	const b = setup(2);
	b.plan([item, { ...item, id: "second" }]);
	b.send({ kind: "brief", ...brief });
	const held = b.effect();
	b.send({
		kind: "effect_failed",
		key: held.key,
		error: "interrupted after worktree add",
	});
	b.send({ kind: "brief", ...brief, item: "second" });
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
	b.send({ kind: "brief", ...brief });
	b.done({ kind: "worktree", base: repo.trunkHead, principles: [] });
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	b.done({ kind: "kept", reason: "private", files: ["before-cancel"] });
	b.send({ kind: "brief", ...brief, item: "other" });
	b.done({ kind: "worktree", base: merged, principles: [] });
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
	b.pub();
	b.send({ kind: "merged", item: "fix", head: merged });
	const op = b.effect().spec.op as JsonObject;
	assert.equal(op.kind, "remove");
	assert.equal(op.merged, true);
	assert.equal(op.mergedHead, merged);
	assert.equal(
		(op.target as JsonObject).path,
		"/repo/.git/keel/32/worker-fix-1",
	);
	const obstruction = b.done({ kind: "occupied", path: "private path" })
		.send![0]!.event;
	assert.equal(b.agent("coordinator").expects.length, 0);
	assert.deepEqual(b.effects(), []);
	b.send({
		kind: "resume",
		cause: obstruction.cause!,
		item: "fix",
		evidence: obstruction.evidence!,
		direction: "leave my notes intact",
	});
	assert.deepEqual(b.effect().spec.op, op);
	assert.match(
		JSON.stringify(
			b.done({ kind: "kept", files: ["private"], reason: "untracked" }).notes,
		),
		/private/,
	);
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
		b.send({ kind: "brief", ...brief, item: "correction" });
		assert.equal((b.effect().spec.op as JsonObject).base, head);
		b.done({ kind: "worktree", base: head, principles: [] });
		assert.match(b.request("worker").text, /precision/);
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
