import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configure, type JsonObject } from "tau/durable";
import {
	answered,
	approved,
	call,
	context,
	data,
	git,
	Keel,
	named,
	say,
	toolResults,
	world,
} from "./setup.ts";

const build = () => call("publish_build", { text: "Ready." });
const report = (verdict: "pass" | "fail", findings: JsonObject[]) =>
	call("publish_verdict", { text: "Checked the proof.", verdict, findings });
const block = (text: string, repeats?: number) => ({
	kind: "block",
	text,
	...(repeats === undefined ? {} : { repeats }),
});
const note = (text: string) => ({ kind: "note", text });
const ruling = (decision: string) => ({
	decision,
	why: "Fits the seam",
	cost: "Extra migration",
	cites: "Mandate: Rules",
});

for (const reason of ["wrong stage", "wrong conversation"] as const) {
	test(`record_ruling refuses ${reason} even when the tool is exposed`, async (t) => {
		const w = await world();
		t.after(() => w.close());
		w.script("worker", reason === "wrong stage" ? build() : say("Question"));
		w.script("verifier", report("pass", []));
		const { k } = await approved(w);
		const id = reason === "wrong stage" ? await named(w, "building") : k;
		if (reason === "wrong conversation")
			await w.harness.commit(
				(tx) => configure(tx, k, { tools: Keel.extension.tools ?? [] }),
				context,
			);
		w.script(
			reason === "wrong stage" ? "worker" : "designer",
			call("record_ruling", ruling("Denied")),
		);
		await w.submit(id, "Record another ruling.");
		await w.settle();
		const result = (await toolResults(w, id)).at(-1);
		assert.equal(result?.tool, "record_ruling");
		assert.equal(result.isError, true);
		assert.doesNotMatch(result.text, /unavailable|not available/i);
		assert.equal((await w.entries(id, "keel.ruling")).length, 0);
	});
}

test("rulings survive refused publication, attach exactly once to their own build and reach the verifier and owner", async (t) => {
	const w = await world();
	t.after(() => w.close());
	const first = ruling("Stream the rows"),
		second = ruling("Use an iterator"),
		third = ruling("Keep CSV");
	w.script(
		"worker",
		...Object.keys(first).map((key) =>
			call("record_ruling", { ...first, [key]: "" }),
		),
		call("record_ruling", first),
		build(),
		call("publish_build", {
			text: "Built.",
			replies: [{ annotation: 0, text: "Kept" }],
		}),
		call("record_ruling", second),
		call("record_ruling", third),
		build(),
	);
	w.script(
		"verifier",
		report("fail", [block("Repair it")]),
		report("pass", [note("Consider a flag"), note("Document it")]),
	);
	const { k, s } = await approved(w, [{ text: "Keep exports" }]);
	await w.open(s.handover(1));
	const I = await named(w, "building"),
		R = await named(w, "verifying");
	const records = await w.entries(I, "keel.ruling");
	assert.deepEqual(records.map(data), [first, second, third]);
	const results = (await toolResults(w, I)).filter(
		(r) => r.tool === "record_ruling",
	);
	assert.deepEqual(
		results.map((r) => r.isError),
		[true, true, true, true, false, false, false],
	);
	const builds = await w.entries(I, "keel.build");
	assert.deepEqual(
		builds.map((b) => data(b).rulings),
		[[records[0]?.id], [records[1]?.id, records[2]?.id]],
	);
	const inputs = (await w.entries(R, "pi.user")).map((e) =>
		JSON.stringify(e.model),
	);
	assert.match(inputs[0] ?? "", /1\. Stream the rows/);
	assert.doesNotMatch(inputs[1] ?? "", /Stream the rows/);
	const handover = String(data((await w.entries(k, "keel.handover"))[0]).text);
	for (const value of [inputs[1] ?? "", handover]) {
		for (const part of [
			"1. Use an iterator",
			"2. Keep CSV",
			"Fits the seam",
			"Extra migration",
			"Mandate: Rules",
		])
			assert.ok(value.includes(part), part);
	}
	assert.doesNotMatch(handover, /Stream the rows/);
	assert.match(handover, /Checked the proof\./);
	assert.match(handover, /1\. Consider a flag/);
	assert.match(handover, /2\. Document it/);
});

test("invalid verdicts cannot advance: pass with a block, fail without one, repeats on a note, no predecessor, non-block or missing number", async (t) => {
	const w = await world();
	t.after(() => w.close());
	w.script("worker", build(), build());
	w.script(
		"verifier",
		report("pass", [block("bad")]),
		report("fail", [note("optional")]),
		report("fail", [block("first", 1)]),
		report("fail", [note("optional"), block("fix")]),
		report("pass", [{ ...note("optional"), repeats: 2 }]),
		report("fail", [block("not a block", 1)]),
		report("fail", [block("missing", 3)]),
		report("pass", []),
	);
	const { s } = await approved(w);
	await w.open(s.handover(1));
	const R = await named(w, "verifying");
	assert.deepEqual(
		(await toolResults(w, R)).map((r) => r.isError),
		[true, true, true, false, true, true, true, false],
	);
	assert.deepEqual(
		(await w.entries(R, "keel.verdict")).map((v) => data(v).verdict),
		["fail", "pass"],
	);
});

test("third report stops automatic rework; owner retry sends notes and resets all lineages for two fresh fixes", async (t) => {
	const w = await world();
	t.after(() => w.close());
	w.script("worker", build(), build(), build());
	w.script(
		"verifier",
		report("fail", [block("A"), block("B")]),
		report("fail", [block("B again", 2), block("A again", 1)]),
		report("fail", [block("B survives", 1), block("A survives", 2)]),
	);
	const { k, s } = await approved(w);
	const stuck = await w.open(s.stuck(1));
	assert.deepEqual(stuck.choices, ["retry", "abort"]);
	const I = await named(w, "building");
	const basis = await w.harness.commit((tx) => tx.entry(stuck.basis), context);
	assert.match(String(data(basis).text), /B survives|A survives/);
	assert.match(String(data(basis).text), /survived two fixes/i);
	assert.equal((await w.entries(I, "pi.user")).length, 3);
	assert.equal((await w.tasks("keel.rework_start")).length, 2);
	w.script("worker", build(), build());
	w.script(
		"verifier",
		report("fail", [block("A again", 2), block("B again", 1)]),
		report("fail", [block("A third", 1)]),
	);
	answered(await w.reply(s.stuck(1), "retry", [{ text: "Change the parser" }]));
	await w.settle();
	const inputs = await w.entries(I, "pi.user");
	assert.equal(inputs.length, 5);
	assert.ok(JSON.stringify(inputs[3]?.model).includes("Change the parser"));
	const again = await w.open(s.stuck(2));
	assert.equal(again.conversation, k);
	assert.match(
		String(
			data(await w.harness.commit((tx) => tx.entry(again.basis), context)).text,
		),
		/A third/,
	);
});

test("unrelated and reappearing blocks do not share counts; distinct problems can run beyond three rounds", async (t) => {
	const w = await world();
	t.after(() => w.close());
	w.script("worker", ...Array.from({ length: 8 }, build));
	w.script(
		"verifier",
		...[
			[block("A")],
			[block("A", 1), block("B")],
			[block("B", 2)],
			[block("A")],
			[block("A returned", 1)],
			[block("C")],
			[block("D")],
		].map((f) => report("fail", f)),
		report("pass", []),
	);
	const { s } = await approved(w);
	await w.open(s.handover(1));
	assert.equal(await w.read(s.stuck(1)), undefined);
	assert.equal((await w.tasks("keel.rework_start")).length, 7);
});

for (const occupant of [
	"directory",
	"attached branch",
	"wrong commit",
	"dirty checkout",
] as const) {
	test(`verifier preserves ${occupant} at the checkout path and offers retry, not a verifier run`, async (t) => {
		const w = await world();
		t.after(() => w.close());
		let checkout = "";
		w.script("worker", async () => {
			const I = await named(w, "building"),
				path = (await w.agent(I)).cwd;
			assert.ok(path);
			const sha = git(path, "rev-parse", "HEAD");
			checkout = `${path}-verify-${sha.slice(0, 12)}`;
			if (occupant === "directory") mkdirSync(checkout);
			else if (occupant === "attached branch")
				git(w.repo, "worktree", "add", "-b", "mine", checkout, sha);
			else git(w.repo, "worktree", "add", "--detach", checkout, sha);
			if (occupant === "wrong commit")
				git(checkout, "commit", "--allow-empty", "-qm", "Verifier's commit");
			writeFileSync(join(checkout, "mine"), "preserve this");
			return build();
		});
		const { s } = await approved(w);
		const stuck = await w.open(s.stuck(1));
		assert.deepEqual(stuck.choices, ["retry", "abort"]);
		assert.equal(w.requests.filter((r) => r.role === "verifier").length, 0);
		assert.equal(readFileSync(join(checkout, "mine"), "utf8"), "preserve this");
		assert.ok(
			String(
				data(await w.harness.commit((tx) => tx.entry(stuck.basis), context))
					.text,
			).includes(checkout),
		);
		if (occupant === "directory") {
			rmSync(checkout, { recursive: true });
			w.script("verifier", report("pass", []));
			answered(await w.reply(s.stuck(1), "retry"));
			await w.settle();
			await w.open(s.handover(1));
		}
	});
}
