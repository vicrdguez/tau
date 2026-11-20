import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Annotation, decision } from "tau";
import { BACKGROUND_CONTEXT as ctx } from "tau/chord";
import type { Storage } from "tau/durable";
import { fauxAnswer } from "tau/testing";
import { ProjectState } from "../../src/kernel/records.ts";
import { stateDoc } from "../../src/kernel/state.ts";
import { git } from "../repo/fixture.ts";
import { openScriptedWorkflow } from "./scenario.ts";

const prompt = "Give shell callers one way to read and write the book.";
const gap = "No shared write function exists.";
const conflict = "GUIDE requires LF; NOTES permits an unterminated line.";
const revisionNotes = [
	"Name the future reader.",
	"Choose the current guide explicitly.",
];
const approvalNote = "Exercise the boundary before migrating book.";
const riderNote = "Preserve the old book when given an empty line.";
const redesigned = "Reject empty input before opening the path.";
const projectName = "book-integrity";
const description = "Keep the book intact on invalid writes.";
const body = "Validate the replacement before truncating the book.";
const ruling = "Reject empty input before redirecting output.";
const rule = "Every stored line ends in LF.";
const gapRuling = "Introduce write_book for all writers.";
const settlement = "GUIDE governs stored bytes; NOTES is historical.";
const grounded = {
	route: "precedent",
	reference: "GUIDE and NOTES disagree on the wire format.",
	audit: {
		exists: "book is a tracked text file.",
		gaps: [{ label: "missing-writer", text: gap }],
		contradictions: [{ label: "wire-format", text: conflict }],
	},
};
const laterReader = "The reporting CLI.";
const readSeam = {
	label: "read-book",
	callersNow: "Shell reports.",
	callersLater: "Scheduled jobs.",
	usage: "```sh\nread_book book\n```",
	signature: "```sh\nread_book() { :; } # path -> stdout\n```",
	owner: "book.sh",
	dependencies: "POSIX cat",
};
const writeSeam = {
	label: "write-book",
	callersNow: "The maintenance script.",
	callersLater: "Shell importers.",
	usage: "```sh\nwrite_book book repaired\n```",
	signature: "```sh\nwrite_book() { :; } # path line -> status\n```",
	owner: "book.sh",
	dependencies: "POSIX builtins",
};
const riders = [
	{ label: "stdout", text: "Read to standard output.", origin: "evidence" },
	{
		label: "indentation",
		text: "Use tabs inside shell functions.",
		origin: "incidental",
	},
	{ label: "empty-input", text: "Reject empty input.", origin: "seeded" },
];
const draft = {
	intent: prompt,
	done: "The book round-trips through both shell calls and stores repaired followed by LF.",
	seams: [readSeam, writeSeam],
	nodes: [
		{
			label: "line-ending",
			rule,
			probe: "Compare the exact bytes of a written line.",
		},
	],
	never: "No second representation of the book.",
	tradeoffs: "Shell functions require sourcing a file.",
	alternatives: "A binary needs a separate installation.",
	settlements: [
		{ label: "missing-writer", ruling: gapRuling },
		{ label: "wire-format", ruling: "Use LF." },
	],
	checks: [
		{
			id: "contract",
			argv: [
				"sh",
				"-c",
				'sh book-check.sh && git rev-parse HEAD > "$(git rev-parse --git-common-dir)/merge-proof"',
			],
			timeoutMs: 5000,
		},
	],
	protectedPaths: ["book-check.sh"],
	riders,
	references: [],
};
const second = {
	...draft,
	seams: [{ ...readSeam, callersLater: laterReader }, writeSeam],
	settlements: [
		draft.settlements[0]!,
		{ label: "wire-format", ruling: settlement },
	],
};
const finalDraft = {
	...second,
	nodes: [
		...second.nodes,
		{
			label: "empty-input",
			rule: redesigned,
			probe: "Write an empty value and compare the old bytes.",
		},
	],
	riders: riders.slice(0, 2),
};

export async function seedBookPolicy(cwd: string) {
	await mkdir(join(cwd, ".keel", "principles"), { recursive: true });
	await writeFile(
		join(cwd, ".keel", "principles", `${projectName}.md`),
		`---\ndescription: "${description}"\n---\n\n${body}\n`,
	);
	await writeFile(join(cwd, "GUIDE"), "Every stored line ends in LF.\n");
	await writeFile(
		join(cwd, "NOTES"),
		"An unterminated stored line is allowed.\n",
	);
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "document current book policy");
	return git(cwd, "rev-parse", "main");
}

export async function openReview(
	cwd: string,
	storage: Storage,
	first: boolean,
) {
	const { store, root, provider, turn, settle } = await openScriptedWorkflow(
		cwd,
		storage,
		first,
	);
	const { harness } = store;
	async function asks() {
		return Object.values(
			(await harness.snapshot(stateDoc(ProjectState), ctx))?.asks ?? {},
		);
	}
	async function subjects() {
		return (await asks()).map((a) => a.local).sort();
	}
	async function review(subject: string) {
		const open = await asks();
		const slot = open.find((a) => a.local === subject);
		assert.ok(slot, `Expected ${subject}; open: ${open.map((a) => a.local)}`);
		const d = await harness.commit((tx) => decision(tx, slot.decision), ctx);
		assert.ok(d?.status === "open");
		const e = await harness.commit((tx) => tx.entry(d.basis), ctx);
		assert.ok(
			e?.data &&
				typeof e.data === "object" &&
				"text" in e.data &&
				typeof e.data.text === "string",
		);
		return { decision: d, text: e.data.text };
	}
	async function answer(
		subject: string,
		choice: string,
		notes: [string, string][] = [],
	) {
		const { decision: d, text } = await review(subject);
		const annotations: Annotation[] = notes.map(([needle, note]) => {
			const start = text.indexOf(needle);
			assert.notEqual(start, -1, `Cannot annotate ${needle} in ${text}`);
			return { text: note, range: { start, end: start + needle.length } };
		});
		const result = await fauxAnswer(store, d.id, {
			choice,
			basis: d.basis,
			annotations,
		});
		assert.equal(result.kind, "answered");
		await settle();
	}
	function expectAll(text: string, parts: string[]) {
		for (const part of parts)
			assert.ok(text.includes(part), `Missing ${part} from ${text}`);
	}
	async function start() {
		provider.setResponses([
			turn("designer", "ground", grounded, prompt),
			turn(
				"designer",
				"publish_mandate",
				{ draft, replies: [] },
				gap,
				conflict,
			),
		]);
		await root.submit({ type: "input", content: prompt }, ctx);
		await settle();
		assert.deepEqual(await subjects(), [
			"mandate/1",
			"rider/1/empty-input",
			"rider/1/indentation",
			"rider/1/stdout",
		]);
		const { text } = await review("mandate/1");
		expectAll(text, [
			gap,
			conflict,
			gapRuling,
			readSeam.usage,
			writeSeam.usage,
			rule,
		]);
	}
	function scriptRevision() {
		provider.setResponses([
			turn(
				"designer",
				"publish_mandate",
				{
					draft: second,
					replies: revisionNotes.map((_, i) => ({
						n: i + 1,
						status: "acted_on",
						reason: [laterReader, settlement][i]!,
					})),
				},
				...revisionNotes,
			),
		]);
	}
	const rework = () =>
		answer("mandate/1", "rework", [
			[readSeam.callersLater, revisionNotes[0]!],
			[conflict, revisionNotes[1]!],
		]);
	async function finish() {
		expectAll((await review("mandate/2")).text, [laterReader, settlement]);
		await answer("rider/2/stdout", "accept");
		await answer("rider/2/indentation", "leave_open");
		provider.setResponses([
			turn(
				"designer",
				"publish_mandate",
				{
					draft: finalDraft,
					replies: [{ n: 1, status: "acted_on", reason: redesigned }],
				},
				riderNote,
			),
		]);
		await answer("rider/2/empty-input", "design", [
			[riders[2]!.text, riderNote],
		]);
		assert.deepEqual(
			await subjects(),
			["mandate/3"],
			"unchanged rider dispositions survive",
		);
		expectAll((await review("mandate/3")).text, [redesigned]);
		assert.equal(
			git(cwd, "for-each-ref", "refs/heads/keel/"),
			"",
			"no build before the review binds",
		);
		const encode = "Encode both shell seams and the protected contract check.";
		const migrate = "Write the repaired book using the approved writer.";
		const check = "! git symbolic-ref -q HEAD && sh book-check.sh";
		const pass = (text: string) =>
			turn("verifier", "publish_verdict", {
				outcome: "pass",
				text,
				blocks: [],
				notes: [],
			});
		provider.setResponses([
			turn(
				"coordinator",
				"publish_plan",
				{
					items: [
						{ id: "encode", kind: "encode", goal: encode, deps: [] },
						{ id: "migrate", kind: "build", goal: migrate, deps: ["encode"] },
					],
					replies: [
						{
							n: 1,
							status: "acted_on",
							reason: "Run the protected check before migrating.",
						},
					],
				},
				approvalNote,
			),
			turn("coordinator", "brief_item", {
				item: "encode",
				goal: encode,
				evidence: "Run sh book-check.sh.",
				fences: "book.sh and book-check.sh",
				nodes: ["read-book", "write-book", "empty-input", "stdout"],
			}),
			turn("worker", "principle", { name: projectName }, "empty-input"),
			turn("worker", "record_ruling", {
				what: ruling,
				why: "Preserve prior bytes.",
				cost: "A failed write loses data.",
				rank: 1,
				follows: "empty-input",
				principles: [projectName],
			}),
			turn("worker", "bash", {
				command: `cat > book.sh <<'SH'\nread_book() { cat "$1"; }\nwrite_book() { [ -n "$2" ] && printf '%s\\n' "$2" > "$1"; }\nSH\ncat > book-check.sh <<'SH'\nset -eu\n. ./book.sh\np=$(mktemp)\ntrap 'rm -f "$p"' EXIT\nwrite_book "$p" probe\nif write_book "$p" ''; then exit 1; fi\nprintf 'probe\\n' | cmp - "$p"\n[ "$(read_book "$p")" = probe ]\nSH\ngit add book.sh book-check.sh && sh book-check.sh && git commit -m 'encode book contract'`,
			}),
			turn("worker", "publish_build", { summary: encode, addresses: [] }),
			turn("verifier", "bash", { command: check }, description),
			pass("Shell contract passes on the Encode publication."),
			turn("coordinator", "brief_item", {
				item: "migrate",
				goal: migrate,
				evidence: "Compare book with the approved line.",
				fences: "book",
				nodes: ["line-ending", "write-book"],
			}),
			turn("worker", "bash", {
				command:
					". ./book.sh && write_book book repaired && git commit -am 'migrate book'",
			}),
			turn("worker", "publish_build", { summary: migrate, addresses: [] }),
			turn(
				"verifier",
				"bash",
				{ command: `${check} && printf 'repaired\\n' | cmp - book` },
				description,
			),
			pass("Migrated bytes match."),
			turn("coordinator", "handoff_build", {
				summary: migrate,
				risk: "Only shell callers exercised.",
			}),
			turn(
				"verifier",
				"bash",
				{ command: `${check} && printf 'repaired\\n' | cmp - book` },
				description,
			),
			pass("The integrated shell contract and migrated bytes match."),
		]);
		await answer("mandate/3", "approve", [[redesigned, approvalNote]]);
		assert.equal(
			provider.getPendingResponseCount(),
			0,
			"all build and verification turns completed",
		);
		assert.deepEqual(await subjects(), ["handover"]);
		expectAll((await review("handover")).text, [
			git(cwd, "rev-parse", "trunk"),
			ruling,
			migrate,
			"The integrated shell contract and migrated bytes match.",
		]);
		await answer("handover", "accept");
		assert.deepEqual(await subjects(), []);
	}
	return {
		root,
		harness,
		start,
		review,
		subjects,
		rework,
		scriptRevision,
		settle,
		finish,
	};
}
