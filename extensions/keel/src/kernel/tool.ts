import { addAbortListener } from "node:events";
import type { Context } from "tau/chord";
import {
	AgentDoc,
	type ConversationId,
	type Cursor,
	defineTool,
	type EntryId,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	type Tx,
} from "tau/durable";
import { type RoleName, storedRole } from "../roles/index.ts";
import {
	type AgentKey,
	agentKey,
	slotKey,
	type Token,
	type WorkId,
	workId,
} from "./ids.ts";
import type { Delivery, LaneEvent, Result } from "./lane.ts";
import { type Address, BindingState, ReceiptState } from "./records.ts";
import { RejectedSeed } from "./routing.ts";
import { stateDoc } from "./state.ts";
import { ledger } from "./storage.ts";

type Self = Readonly<
	Address & {
		agent: AgentKey;
		role: RoleName;
		conversation: ConversationId;
		cwd: string | null;
		token: Token | null;
	}
>;
type Args<P extends object> = Parameters<ToolRegistration<P>["execute"]>[0];
type View = (lane: string) => unknown;
type Header = {
	lane: string;
	roles: readonly RoleName[];
	name: string;
	gate?: "adopt" | "standing" | "expectation";
};
type ToolSpec<P extends object, F> = Header & {
	description: string;
	parameters: P;
	terminate: boolean | ((args: Args<P>) => boolean);
	expectation?(args: Args<P>): Token;
	observe(args: Args<P>, self: Self, context: Context, view: View): Promise<F>;
	event(args: Args<P>, facts: F, self: Self): LaneEvent;
};
type PlainTool<P extends object> = Omit<ToolSpec<P, undefined>, "observe"> & {
	observe?: never;
};

type Publish = (
	api: ToolExecutionApi,
	context: Context,
	selected: Token | undefined,
	prepare: (
		self: Self,
		view: View,
	) => Promise<{ event: LaneEvent; terminate: boolean }>,
) => Promise<ToolExecutionResult>;
export type LaneTool = Header & {
	observes: boolean;
	build(publish: Publish): ToolRegistration;
};

// Conversation.abort waits for tools to exit. An observation blocked on external
// I/O may ignore cancellation; stop waiting without ever using its late facts.
async function observe<F>(
	read: () => Promise<F>,
	context: Context,
): Promise<F> {
	const signal = context.abortSignal;
	if (!signal) return read();
	signal.throwIfAborted();
	let listener: Disposable | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		listener = addAbortListener(signal, () => reject(signal.reason));
	});
	try {
		return await Promise.race([read(), cancelled]);
	} finally {
		listener?.[Symbol.dispose]();
	}
}

/** Capture schema-inferred args and observed facts together before collecting unlike tools. */
export function defineLaneTool<P extends object, F>(
	spec: ToolSpec<P, F>,
): LaneTool;
export function defineLaneTool<P extends object>(spec: PlainTool<P>): LaneTool;
export function defineLaneTool<P extends object, F>(
	spec: ToolSpec<P, F> | PlainTool<P>,
): LaneTool {
	const { lane, roles, name, description, parameters } = spec;
	return {
		lane,
		roles,
		name,
		gate: spec.gate ?? "expectation",
		observes: !!spec.observe,
		build: (publish) =>
			defineTool<P>({
				name,
				description,
				parameters,
				callers: ["model"],
				replay: "safe",
				executionMode: "sequential",
				execute(args, api, context) {
					return publish(
						api,
						context,
						spec.expectation?.(args),
						async (self, view) => ({
							event: spec.observe
								? spec.event(
										args,
										await observe(
											() => spec.observe(args, self, context, view),
											context,
										),
										self,
									)
								: spec.event(args, undefined, self),
							terminate:
								typeof spec.terminate === "boolean"
									? spec.terminate
									: spec.terminate(args),
						}),
					);
				},
			}),
	};
}

/** undefined = malformed call/input (refuse); null = no Keel input precedes this call. */
async function callToken(
	tx: Tx,
	api: ToolExecutionApi,
	selected: Token | undefined,
): Promise<string | null | undefined> {
	const task = await tx.task(api.taskId);
	const input = task?.input;
	if (
		task?.kind !== "pi.tool" ||
		task.conversationId !== api.conversationId ||
		!input ||
		typeof input !== "object" ||
		!("kind" in input) ||
		input.kind !== "model" ||
		!("assistant" in input) ||
		typeof input.assistant !== "number" ||
		!Number.isSafeInteger(input.assistant)
	)
		return undefined;
	// pi.tool persists its assistant EntryId as a JSON number. Later queued inputs
	// must not retroactively grant this assistant a different expectation.
	const query = {
		conversationId: api.conversationId,
		maxEntryId: input.assistant as EntryId,
		order: "descending" as const,
	};
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries(query, 32, cursor);
		for (const entry of page.items) {
			if (entry.kind !== "keel.input") continue;
			const data = entry.data;
			if (
				!data ||
				typeof data !== "object" ||
				!("token" in data) ||
				typeof data.token !== "string"
			)
				return undefined;
			if (selected === undefined || data.token === selected) return data.token;
		}
		cursor = page.next;
	} while (cursor);
	return selected === undefined ? null : undefined;
}

type Refusal = { reject: string };
async function admit(
	tx: Tx,
	conversation: ConversationId,
	spec: Header,
	token: string | null | undefined,
	selected: Token | undefined,
): Promise<Self | Refusal> {
	const { binding } = await tx.doc(stateDoc(BindingState), conversation);
	if (spec.gate === "adopt" && !binding) {
		const record = await tx.conversation(conversation);
		const config = await tx.doc(AgentDoc, conversation);
		if (
			!record ||
			record.owner ||
			record.parent ||
			!spec.roles.includes("designer") ||
			!Array.isArray(config.tools) ||
			!config.tools.includes(spec.name) ||
			!config.cwd
		)
			return { reject: "Adoption needs an unbound entry conversation" };
		return {
			lane: spec.lane,
			work: workId(conversation),
			agent: agentKey("designer"),
			role: "designer",
			conversation,
			cwd: config.cwd,
			token: null,
		};
	}
	if (!binding || !spec.roles.includes(storedRole(binding.role)))
		return { reject: `This role cannot call ${spec.name}` };
	const { lane, work, key: agent, role } = binding;
	const slot = (await ledger(tx, work)).agents[slotKey(lane, agent)];
	if (
		slot?.status !== "active" ||
		slot.conversation !== conversation ||
		slot.role !== role
	)
		return { reject: "This conversation is not the active bound agent" };
	let matched: Token | null = null;
	if (spec.gate !== "standing") {
		const eligible = slot.open.filter((e) => e.tools.includes(spec.name));
		if (selected === undefined && eligible.length > 1)
			return { reject: `Ambiguous open expectation for ${spec.name}` };
		const match = eligible.find((e) =>
			token === null
				? e.unsolicited && role === "designer" && work === conversation
				: e.token === token,
		);
		if (!match)
			return { reject: `No matching open expectation for ${spec.name}` };
		matched = match.token;
	}
	return Object.freeze({
		lane,
		work,
		agent,
		role: storedRole(role),
		conversation,
		cwd: slot.cwd,
		token: matched,
	});
}

function output(receipt: Readonly<ReceiptState>): ToolExecutionResult {
	return {
		output:
			receipt.reply === null ? [] : [{ type: "text", text: receipt.reply }],
		isError: receipt.isError,
		control: { terminate: receipt.terminate },
	};
}

function finish(receipt: ReceiptState, result: Result, terminate: boolean) {
	const error = "reject" in result;
	receipt.reply = error ? result.reject : result.reply;
	receipt.terminate = !error && terminate;
	receipt.isError = error;
	return output(receipt);
}

export function wrapTool(
	spec: LaneTool,
	transact: (
		tx: Tx,
		delivery: Delivery,
		now: number,
		caller: WorkId | null,
	) => Promise<Result>,
	views: (tx: Tx, self: Self) => Promise<View>,
	scopeForLane: (name: string) => "session" | "conversation",
) {
	const targetScope = scopeForLane(spec.lane);
	if (spec.gate === "adopt" && targetScope !== "conversation")
		throw new Error("Adoption needs a work lane");
	const tool = spec.build(async (api, context, selected, prepare) => {
		// Document presence, not reply text, marks a completed call (a reply may be null).
		const receipt = stateDoc(ReceiptState);
		const saved = await api.snapshot(receipt, api.taskId, context);
		if (saved) return output(saved);
		const first = await api.commit(async (tx) => {
			const token =
				spec.gate === "standing" ? null : await callToken(tx, api, selected);
			const self = await admit(tx, api.conversationId, spec, token, selected);
			if ("reject" in self)
				return {
					done: finish(await tx.doc(receipt, api.taskId), self, false),
				} as const;
			return {
				token,
				self,
				view: spec.observes ? await views(tx, self) : () => null,
			} as const;
		}, context);
		if (first.done) return first.done;
		const { event, terminate } = await prepare(first.self, first.view);
		return api
			.commit(async (tx) => {
				const doc = await tx.doc(receipt, api.taskId);
				// The transcript cutoff is immutable, but a token, binding or cwd may
				// have changed during observe. Never apply facts read for another agent.
				const self = await admit(
					tx,
					api.conversationId,
					spec,
					first.token,
					selected,
				);
				if ("reject" in self) return finish(doc, self, false);
				const prev = first.self;
				if (
					prev.token !== self.token ||
					prev.work !== self.work ||
					prev.lane !== self.lane ||
					prev.agent !== self.agent ||
					prev.role !== self.role ||
					prev.cwd !== self.cwd
				)
					return finish(
						doc,
						{ reject: "The expectation changed during observation" },
						false,
					);
				if (targetScope === "conversation" && self.work === null)
					return finish(doc, { reject: "This tool needs a bound work" }, false);
				const work = targetScope === "session" ? null : self.work;
				const result = await transact(
					tx,
					{ lane: spec.lane, work, event },
					api.now(),
					self.work,
				);
				if (
					spec.gate === "adopt" &&
					self.token === null &&
					!("reject" in result)
				) {
					const { binding } = await tx.doc(
						stateDoc(BindingState),
						api.conversationId,
					);
					if (
						binding?.role !== "designer" ||
						binding.work !== self.work ||
						binding.key !== self.agent ||
						binding.lane !== self.lane
					)
						throw new Error("Adopting reduction must declare its designer");
				}
				return finish(doc, result, terminate);
			}, context)
			.catch((error) => {
				if (!(error instanceof RejectedSeed)) throw error;
				return api.commit(
					async (tx) =>
						finish(
							await tx.doc(receipt, api.taskId),
							{ reject: error.message },
							false,
						),
					context,
				);
			});
	});
	return { roles: spec.roles, tool };
}
