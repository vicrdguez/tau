import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, Storage } from "tau/durable";
import { openNodeSqliteStorage } from "tau/durable";
import { Work } from "../../src/work.ts";
import {
	answered,
	call,
	context,
	data,
	git,
	plannedPath,
	subjects,
	toolResults,
	world,
} from "../setup.ts";

// One run of a crash scenario on a SQLite store and a real repository in `dir`. This process kills itself with
// SIGKILL at the point under test; the parent opens the same files again in a new process and looks.
const [scenario = "", dir = "", step = ""] = process.argv.slice(2);
const say = (value: unknown) => writeSync(1, `${JSON.stringify(value)}\n`);
const die = () => process.kill(process.pid, "SIGKILL");
const repo = join(dir, "export-tool");
process.env.TAU_TEST_PID = String(process.pid);

const real = await openNodeSqliteStorage(join(dir, "store.sqlite"));
/** Forwards to SQLite, and dies around the commit that the scenario names. */
const storage = new Proxy(real, {
	get(target, key) {
		const value = Reflect.get(target, key, target);
		if (key !== "commit" || typeof value !== "function")
			return typeof value === "function" ? value.bind(target) : value;
		return async (...args: Parameters<Storage["commit"]>) => {
			const write = JSON.stringify(args[0]);
			if (step === "first" && scenario === "worktree" && worktreeExists())
				die();
			const result = await value.apply(target, args);
			if (
				step === "first" &&
				scenario === "publish" &&
				write.includes('"keel.mandate"')
			)
				die();
			if (
				step === "first" &&
				scenario === "plan" &&
				write.includes('"keel.prepare"')
			)
				die();
			if (
				step === "first" &&
				scenario === "ruling" &&
				write.includes('"keel.ruling"')
			)
				die();
			if (
				step === "first" &&
				scenario === "verify-plan" &&
				write.includes('"keel.verify_start"') &&
				k
			) {
				const checkout =
					plannedPath(repo, k) +
					"-verify-" +
					git(plannedPath(repo, k), "rev-parse", "HEAD").slice(0, 12);
				if (!write.includes(checkout) || existsSync(checkout))
					throw new Error("Checkout not planned before creation");
				writeFileSync(join(dir, "planned"), checkout);
				die();
			}
			return result;
		};
	},
});
let k: ConversationId | undefined;
const worktreeExists = () =>
	k !== undefined && existsSync(join(plannedPath(repo, k), ".git"));

const w = await world({ storage, repo, now: () => Date.UTC(2026, 10, 14) });

if (step === "first") {
	await w.setOptions({
		designer: "faux/faux-a",
		worker: "faux/faux-a",
		verifier: "faux/faux-b",
	});
	k = await w.create();
	say({ k });
	w.script("designer", call("publish_mandate", { text: "The mandate." }));
	if (scenario === "ruling")
		w.script(
			"worker",
			call("record_ruling", {
				decision: "d",
				why: "w",
				cost: "c",
				cites: "ref",
			}),
		);
	if (scenario === "verify-plan")
		w.script("worker", call("publish_build", { text: "built" }));
	if (scenario === "g1")
		w.script(
			"worker",
			call("bash", {
				command:
					"printf 'json' > export.js && git add -A && git commit -qm 'Add --json' && kill -9 $TAU_TEST_PID",
			}),
		);
	await w.submit(k, "Add a --json flag.");
	await w.settle();
	answered(await w.reply(subjects(k).mandate(1), "approve"));
	await w.settle();
	say({ k, survived: true });
	process.exit(0);
}

const found = (await w.events()).find((e) => e.stage === "mandate_review");
k = found?.conversation as ConversationId;
const s = subjects(k);
if (scenario === "plan") await w.setOptions({ base: "other" });
if (scenario === "g1" || scenario === "ruling")
	w.script("worker", call("publish_build", { text: "Built." }));
await w.settle();
const events = await w.events();
const I = events.find((e) => e.stage === "building")?.conversation as
	| ConversationId
	| undefined;
const path = plannedPath(repo, k);
const builds = I === undefined ? [] : await w.entries(I, "keel.build");
const rulings = I ? await w.entries(I, "keel.ruling") : [];
const R = events.find((e) => e.stage === "verifying")?.conversation as
	| ConversationId
	| undefined;
const cwd = R ? (await w.agent(R)).cwd : undefined;
const receipts = (await w.harness.snapshot(Work, k, context))?.receipts ?? {};
const rulingResult = I
	? (await toolResults(w, I)).find((r) => r.tool === "record_ruling")
	: undefined;
say({
	rulings: rulings.length,
	rulingId: rulings[0]?.id,
	buildRulings: builds.map((b) => data(b).rulings),
	rulingResult: rulingResult?.text,
	receipt: Object.values(receipts).find(
		(v) =>
			v.toLowerCase().includes("ruling") && v.includes(String(rulings[0]?.id)),
	),
	verifiers: events.filter((e) => e.stage === "verifying").length,
	plannedCheckout:
		scenario === "verify-plan"
			? readFileSync(join(dir, "planned"), "utf8")
			: null,
	verifierCwd: cwd,
	verifierHead: cwd ? git(cwd, "rev-parse", "HEAD") : null,
	mandates: (await w.entries(k, "keel.mandate")).length,
	mandate1: (await w.read(s.mandate(1)))?.status ?? null,
	mandate2: (await w.read(s.mandate(2)))?.status ?? null,
	stages: events.map((e) => e.stage),
	designerRequests: w.requests.filter((r) => r.role === "designer").length,
	worktrees: git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length,
	base: git(repo, "rev-parse", "main"),
	workers: events.filter((e) => e.stage === "building").length,
	commitsOnBranch: existsSync(path)
		? Number(git(path, "rev-list", "--count", "main..HEAD"))
		: null,
	head: existsSync(path) ? git(path, "rev-parse", "HEAD") : null,
	buildShas: builds.map((b) => data(b).sha),
	bash:
		I === undefined
			? []
			: (await toolResults(w, I))
					.filter((r) => r.tool === "bash")
					.map((r) => ({ isError: r.isError, text: r.text })),
});
await w.close();
process.exit(0);
