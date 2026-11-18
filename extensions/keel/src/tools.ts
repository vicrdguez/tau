import { emit, modelRef, request, role } from "tau";
import type { Context } from "tau/chord";
import {
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type Tx,
} from "tau/durable";
import { arr, int, obj, oneOf, opt, str } from "tau/schema";
import { publishedHead } from "./git.ts";
import { verifier } from "./roles.ts";
import {
	handoff,
	inD,
	mandateAnswer,
	reworkStart,
	stuck,
	verifyStart,
} from "./tasks.ts";
import {
	Build,
	Handover,
	KeelEvent,
	KeelOptions,
	listedFindings,
	listedRulings,
	Mandate,
	Note,
	Owner,
	owesHandoff,
	Ruling,
	subject,
	unreplied,
	Verdict,
	workOf,
} from "./work.ts";

type Outcome = { text: string } | { refused: string };
/** The receipt and all effects of a successful call land in the same transaction. */
async function record(
	api: ToolExecutionApi,
	context: Context,
	terminate: boolean,
	body: (tx: Tx, found: Awaited<ReturnType<typeof workOf>>) => Promise<Outcome>,
): Promise<ToolExecutionResult> {
	const result = await api.commit(async (tx): Promise<Outcome> => {
		const found = await workOf(tx, api.conversationId);
		const saved = found.work.receipts[api.taskId];
		if (saved !== undefined) return { text: saved };
		const outcome = await body(tx, found);
		if ("text" in outcome) found.work.receipts[api.taskId] = outcome.text;
		return outcome;
	}, context);
	if ("refused" in result)
		return { output: [{ type: "text", text: result.refused }], isError: true };
	return {
		output: [{ type: "text", text: result.text }],
		...(terminate && { control: { terminate: true } }),
	};
}
const nonempty = str({ minLength: 1 });
const replies = opt(arr(obj({ annotation: int({ minimum: 0 }), text: str() })));

export const publishMandate = defineTool({
	name: "publish_mandate",
	description:
		"Publish the Mandate for the owner's review. Reply to every annotation by number when revising.",
	parameters: obj({ text: nonempty, replies }),
	replay: "safe",
	executionMode: "sequential",
	callers: ["model"],
	execute: (args, api, context) =>
		record(api, context, true, async (tx, { k, work }) => {
			if (
				api.conversationId !== k ||
				(work.stage !== "designing" && work.stage !== "mandate_review")
			)
				return {
					refused: `The Mandate cannot be published here. The work is ${work.stage}.`,
				};
			const missing = await unreplied(tx, work, args.replies);
			if (missing) return { refused: missing };
			const basis = await tx.appendEntry(Mandate, k, { data: args });
			work.stage = "mandate_review";
			delete work.owes;
			const asked = await request(tx, {
				subject: subject(k, "mandate"),
				title: "Review the Mandate",
				basis,
				choices: ["approve", "revise", "abort"],
				conversation: k,
				then: mandateAnswer,
				requestedAt: api.now(),
			});
			work.waiting.mandate = asked.id;
			await emit(tx, KeelEvent, {
				text: "The Mandate is ready for review.",
				at: api.now(),
				conversation: k,
				stage: work.stage,
			});
			return {
				text: `Published the Mandate for review in decision ${asked.id}. End your turn.`,
			};
		}),
});

export const recordRuling = defineTool({
	name: "record_ruling",
	description: "Record a decision for the next build and continue working.",
	parameters: obj({
		decision: nonempty,
		why: nonempty,
		cost: nonempty,
		cites: nonempty,
	}),
	replay: "safe",
	executionMode: "sequential",
	callers: ["model"],
	execute: (args, api, context) =>
		record(api, context, false, async (tx, { k, work }) => {
			if (
				api.conversationId !== work.worker ||
				!owesHandoff(work, k, api.conversationId)
			)
				return {
					refused: `Only the worker on an unpublished build can record a ruling. The work is ${work.stage}.`,
				};
			const ruling = await tx.appendEntry(Ruling, api.conversationId, {
				data: args,
			});
			work.rulings.push(ruling.id);
			work.pendingRulings.push(ruling.id);
			return { text: `Recorded ruling ${ruling.id} for the next build.` };
		}),
});

export const publishBuild = defineTool({
	name: "publish_build",
	description:
		"Publish the commit at the head of your clean worktree for verification.",
	parameters: obj({ text: nonempty, replies }),
	replay: "safe",
	executionMode: "sequential",
	callers: ["model"],
	execute: (args, api, context) =>
		record(api, context, true, async (tx, { k, work }) => {
			const { plan, accepted } = work;
			if (
				!plan ||
				!accepted ||
				api.conversationId !== work.worker ||
				!owesHandoff(work, k, api.conversationId)
			)
				return {
					refused: `Nothing is to be built now. The work is ${work.stage}.`,
				};
			const missing = await unreplied(tx, work, args.replies);
			if (missing) return { refused: missing };
			const head = await publishedHead(plan);
			if ("refused" in head) return head;
			const { sha } = head;
			const checkout = `${plan.path}-verify-${sha.slice(0, 12)}`;
			const fixes = work.candidate?.verdict;
			const build = await tx.appendEntry(Build, api.conversationId, {
				data: {
					...args,
					mandate: accepted.mandate,
					sha,
					rulings: [...work.pendingRulings],
					...(fixes !== undefined && { fixes }),
				},
			});
			if (work.verifier === undefined) {
				const o = await KeelOptions.read(tx);
				work.verifier = await role(
					tx,
					verifier(modelRef(o.verifier), checkout),
					{ kind: "ownerless" },
				);
				(await tx.doc(Owner, work.verifier)).work = k;
			}
			work.candidate = { build: build.id, sha, checkout };
			work.pendingRulings = [];
			delete work.owes;
			await tx.createTask(
				verifyStart,
				{ build: build.id, verifier: work.verifier },
				inD(k),
			);
			await emit(tx, KeelEvent, {
				text: `Build ${sha} is published for verification.`,
				at: api.now(),
				conversation: api.conversationId,
				stage: work.stage,
				sha,
			});
			return {
				text: `Published ${sha} for verification as build ${build.id}. End your turn.`,
			};
		}),
});

export const publishVerdict = defineTool({
	name: "publish_verdict",
	description:
		"Pass only without blocks. Fail with at least one block. Use repeats only for a surviving numbered block of the previous verdict.",
	parameters: obj({
		text: nonempty,
		verdict: oneOf(["pass", "fail"]),
		findings: arr(
			obj({
				kind: oneOf(["block", "note"]),
				text: nonempty,
				repeats: opt(int({ minimum: 1 })),
			}),
		),
	}),
	replay: "safe",
	executionMode: "sequential",
	callers: ["model"],
	execute: (args, api, context) =>
		record(api, context, true, async (tx, { k, work }) => {
			const { candidate, plan, accepted, worker } = work;
			if (
				api.conversationId !== work.verifier ||
				work.stage !== "verifying" ||
				!candidate ||
				candidate.verdict !== undefined ||
				!plan ||
				!accepted ||
				!worker
			)
				return {
					refused: `No build waits for a verdict here. The work is ${work.stage}.`,
				};
			const counts: Record<string, number> = {};
			let survivor: string | undefined;
			for (const [i, { kind, text, repeats }] of args.findings.entries()) {
				if (kind === "note") {
					if (repeats !== undefined)
						return { refused: "Only a block can repeat a previous block." };
					continue;
				}
				const prior =
					repeats === undefined ? undefined : work.blockCounts[repeats];
				if (repeats !== undefined && prior === undefined)
					return {
						refused: `No block ${repeats} in the previous failing verdict.`,
					};
				const count = prior === undefined ? 0 : prior + 1;
				counts[i + 1] = count;
				if (count >= 2) survivor ??= text;
			}
			const requiredVerdict = Object.keys(counts).length ? "fail" : "pass";
			if (args.verdict !== requiredVerdict)
				return {
					refused: "Fail requires at least one block; pass allows only notes.",
				};
			const handoverText =
				args.verdict === "pass"
					? `Commit ${candidate.sha} on branch ${plan.branch} builds the approved Mandate and passed verification.\n\n${args.text}\n\nNotes:\n${listedFindings(args.findings, "note")}\n\nRulings:\n${await listedRulings(tx, work.rulings)}`
					: "";
			const { sha } = candidate;
			const verdict = await tx.appendEntry(Verdict, api.conversationId, {
				data: { ...args, build: candidate.build, sha },
			});
			candidate.verdict = verdict.id;
			work.blockCounts = counts;
			if (survivor !== undefined) {
				const reason = `Block "${survivor}" survived two fixes. Retry with direction or abort.`;
				const basis = await tx.appendEntry(Note, worker, {
					data: {
						text: `${reason}\n\nThe blocks of this verdict, as retry sends them to the worker:\n${listedFindings(args.findings, "block")}`,
					},
				});
				work.waiting.stuck = (await stuck(tx, k, basis, api.now())).id;
				work.retry = worker;
				work.stalled = verdict.id;
				await emit(tx, KeelEvent, {
					text: reason,
					at: api.now(),
					conversation: worker,
					stage: work.stage,
					sha,
				});
			} else if (args.verdict === "fail") {
				await tx.createTask(
					reworkStart,
					{ verdict: verdict.id, worker },
					inD(k),
				);
				await emit(tx, KeelEvent, {
					text: `Verification of ${sha} failed.`,
					at: api.now(),
					conversation: api.conversationId,
					stage: work.stage,
					sha,
				});
			} else {
				const basis = await tx.appendEntry(Handover, k, {
					data: {
						text: handoverText,
						mandate: accepted.mandate,
						sha,
						build: candidate.build,
						verdict: verdict.id,
						branch: plan.branch,
					},
				});
				work.stage = "handover_review";
				work.waiting.handover = (
					await request(tx, {
						subject: subject(k, "handover"),
						title: `Hand over ${sha}`,
						basis,
						choices: ["approve", "abort"],
						conversation: k,
						then: handoff,
						requestedAt: api.now(),
					})
				).id;
				await emit(tx, KeelEvent, {
					text: `Verification passed. The hand-over of ${sha} waits for you.`,
					at: api.now(),
					conversation: k,
					stage: work.stage,
					sha,
				});
			}
			return { text: `Published verdict ${verdict.id}. End your turn.` };
		}),
});
