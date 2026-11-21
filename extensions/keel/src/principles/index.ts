import {
	type Cursor,
	defineEntry,
	defineTool,
	type Extension,
	type Tx,
} from "tau/durable";
import { obj, str } from "tau/schema";
import { slotKey } from "../kernel/ids.ts";
import {
	BindingState,
	ProjectState,
	ReceiptState,
	WorkState,
} from "../kernel/records.ts";
import { stateDoc } from "../kernel/state.ts";
import { activeSlot, ledger } from "../kernel/storage.ts";
import type { CheckCitations } from "../kernel/tool.ts";
import type { LandingSample } from "../lanes/queue/public.ts";
import { bodyOf, indexFor, projectPrincipleNames, render } from "./catalog.ts";

export { indexFor };

const roles = [
	"designer",
	"worker",
	"coordinator",
	"verifier",
	"diagnoser",
] as const;
const pull = defineEntry<{ name: string }>("keel.pull");
const tool = defineTool({
	name: "principle",
	description: "Read a principle by its name in the index.",
	parameters: obj({ name: str({ minLength: 1 }) }),
	callers: ["model"],
	replay: "safe",
	executionMode: "sequential",
	async execute({ name }, api, ctx) {
		const receipt = stateDoc(ReceiptState);
		const saved = await api.snapshot(receipt, api.taskId, ctx);
		if (saved)
			return {
				isError: saved.isError,
				output: [{ type: "text", text: saved.reply! }],
			};
		const pin = (
			await api.snapshot(stateDoc(BindingState), api.conversationId, ctx)
		)?.projectPrinciples;
		const body = bodyOf((await api.agent(ctx)).cwd, name, pin ?? undefined);
		const reply = body ?? `No principle named ${name} in this checkout.`;
		return api.commit(async (tx) => {
			Object.assign(await tx.doc(receipt, api.taskId), {
				reply,
				isError: body === undefined,
				terminate: false,
			});
			if (body !== undefined)
				await tx.appendEntry(pull, api.conversationId, { data: { name } });
			return {
				isError: body === undefined,
				output: [{ type: "text" as const, text: reply }],
			};
		}, ctx);
	},
});
export const principleTools = [{ roles, tool }];
const section: NonNullable<Extension["sections"]>[number] = {
	key: "keel-principles",
	async render({ agent, conversationId, read }, ctx) {
		const state = await read.snapshot(
			stateDoc(BindingState),
			conversationId,
			ctx,
		);
		const binding = state?.binding;
		if (!binding) return undefined;
		const ledger =
			binding.work === null
				? (await read.snapshot(stateDoc(ProjectState), ctx))?.ledger
				: await read.snapshot(stateDoc(WorkState), binding.work, ctx);
		return activeSlot(ledger, binding, conversationId)
			? indexFor(agent.cwd, agent.tools, state.projectPrinciples ?? undefined)
			: undefined;
	},
};
export const principleSections = [{ roles, section }];

// Credit belongs to this conversation. A declaration or queued task isn't proof the
// worker received the body. Read the tagged inputs and pulls preceding its assistant turn.
const checkCitations: CheckCitations = async (
	tx,
	conversationId,
	maxEntryId,
	names,
) => {
	const missing = new Set(names);
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries(
			{ conversationId, maxEntryId, order: "descending" },
			64,
			cursor,
		);
		for (const e of page.items) {
			const d = e.data;
			if (!d || typeof d !== "object" || Array.isArray(d)) continue;
			if (e.kind === "keel.pull" && typeof d.name === "string")
				missing.delete(d.name);
			if (e.kind === "keel.input")
				for (const group of [d.bound, d.triggered])
					if (Array.isArray(group))
						for (const n of group) if (typeof n === "string") missing.delete(n);
		}
		cursor = page.next;
	} while (missing.size && cursor);
	return missing.size
		? `Pull the principle first: ${[...missing].join(", ")}.`
		: null;
};
export const principleInputs = { render, checkCitations };

/** Read actual deliveries and pulls for the sweep's bounded sample of landed items. */
export async function principleUsage(tx: Tx, samples: LandingSample[]) {
	return Promise.all(
		samples.map(async ({ work, worker, kind, citations }) => {
			const conversationId = (await ledger(tx, work)).agents[
				slotKey("build", worker)
			]?.conversation;
			const pulled = new Set<string>();
			const delivered = new Set<string>();
			if (!conversationId) return null;
			const pin = (await tx.doc(stateDoc(BindingState), conversationId))
				.projectPrinciples;
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanEntries(
					{ conversationId, order: "descending" },
					64,
					cursor,
				);
				cursor = page.next;
				for (const e of page.items) {
					const d = e.data;
					if (!d || typeof d !== "object" || Array.isArray(d)) continue;
					if (e.kind === "keel.pull" && typeof d.name === "string")
						pulled.add(d.name);
					if (e.kind === "keel.input")
						for (const names of [d.bound, d.triggered]) {
							if (Array.isArray(names))
								for (const name of names)
									if (typeof name === "string") delivered.add(name);
						}
				}
			} while (cursor);
			return {
				work,
				worker,
				kind,
				citations,
				pulled: [...pulled],
				delivered: [...delivered],
				project: projectPrincipleNames(pin ?? []),
			};
		}),
	).then((items) => items.filter((item) => item !== null));
}
