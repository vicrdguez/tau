import { createHash } from "node:crypto";
import { emit, request, withdraw } from "tau";
import {
	type AgentChange,
	type ConversationId,
	configure,
	defineEntry,
	type JsonObject,
	type Tx,
} from "tau/durable";
import type { ProjectPrincipleFile } from "../repo/index.ts";
import type { RoleName } from "../roles/index.ts";
import { agentKey, slotKey, subjectKey } from "./ids.ts";
import type { AgentSlot } from "./records.ts";
import { BindingState } from "./records.ts";
import type { Frame } from "./routing.ts";
import { stateDoc } from "./state.ts";
import { ledger, project } from "./storage.ts";
import type { makeTasks } from "./tasks.ts";

const basisEntry = defineEntry<{ text: string }>("keel.basis");
const eventEntry = defineEntry<{
	text: string;
	at: number;
	conversation?: ConversationId;
}>("keel.event");
const background = (conversationId: ConversationId) =>
	({
		conversationId,
		ownership: { kind: "conversation" },
		background: true,
	}) as const;

export type RenderInput = (
	facts: {
		role: RoleName;
		cwd: string;
		situation?: string | undefined;
		paths?: readonly string[] | undefined;
		projectPrinciples?: readonly ProjectPrincipleFile[] | undefined;
	},
	text: string,
) => { text: string; data?: JsonObject };

/** All table operations here are writes. Deliveries are durable tasks, never submits. */
export async function reconcile(
	tx: Tx,
	frame: Frame,
	tasks: ReturnType<typeof makeTasks>,
	settings: (role: RoleName) => AgentChange,
	now: number,
	renderInput?: RenderInput,
) {
	const { lane, work } = frame;
	const address = { lane, work };
	const p = await project(tx);
	const slots = await ledger(tx, work);
	const { asks, agents, effects } = frame.declarations();
	const prefix = slotKey(lane, "");
	const active = new Set<string>();

	const stop = async (key: string, slot: AgentSlot) => {
		slot.stop = await tx.createTask(
			tasks.stop,
			{ ...address, key: agentKey(key), conversation: slot.conversation },
			background(slot.conversation),
		);
	};

	for (const agent of agents) {
		const key = slotKey(lane, agent.key);
		if (active.has(key)) throw new Error(`Duplicate agent: ${key}`);
		active.add(key);
		if (!slots.agents[key]) {
			const conversation =
				work !== null && agent.role === "designer"
					? work
					: (await tx.createConversation({ ownership: { kind: "ownerless" } }))
							.id;
			const binding = await tx.doc(stateDoc(BindingState), conversation);
			if (binding.binding)
				throw new Error(`Designer conversation ${conversation} already bound`);
			await configure(tx, conversation, {
				...settings(agent.role),
				cwd: agent.cwd ?? p.root,
			});
			binding.binding = {
				...address,
				key: agent.key,
				role: agent.role,
			};
			binding.projectPrinciples =
				agent.projectPrinciples?.map((file) => ({ ...file })) ?? null;
			if (work === null) p.anchor ??= conversation;
			slots.agents[key] = {
				conversation,
				role: agent.role,
				cwd: agent.cwd,
				open: [],
				used: [],
				stop: null,
				status: agent.paused ? "paused" : "active",
			};
		}
		const slot = slots.agents[key];
		if (agent.role !== slot.role)
			throw new Error(`Role changed for stable agent ${key}`);
		if (agent.paused && slot.status === "active") await stop(agent.key, slot);
		slot.status = agent.paused ? "paused" : "active";
		if (!agent.paused) slot.stop = null;
		slot.cwd = agent.cwd ?? frame.root;
		const open: AgentSlot["open"] = [];
		for (const exp of agent.paused ? [] : agent.expects) {
			if (open.some((e) => e.token === exp.token))
				throw new Error(`Duplicate expectation: ${exp.token}`);
			open.push({
				token: exp.token,
				tools: [...exp.tools],
				unsolicited: exp.input === null,
			});
			if (!slot.open.some((e) => e.token === exp.token)) {
				if (slot.used.includes(exp.token))
					throw new Error(`Reused token ${exp.token} on ${key}`);
				slot.used.push(exp.token);
				if (!exp.input) continue;
				const text = exp.input();
				const rendered = renderInput?.(
					{
						role: agent.role,
						cwd: slot.cwd,
						situation: exp.situation,
						paths: exp.paths,
						projectPrinciples:
							(await tx.doc(stateDoc(BindingState), slot.conversation))
								.projectPrinciples ?? undefined,
					},
					text,
				) ?? { text };
				await tx.createTask(
					tasks.deliver,
					{
						...address,
						key: agent.key,
						conversation: slot.conversation,
						token: exp.token,
						...rendered,
					},
					background(slot.conversation),
				);
			}
		}
		slot.open = open;
	}
	for (const [key, slot] of Object.entries(slots.agents)) {
		if (!key.startsWith(prefix) || active.has(key) || slot.status === "retired")
			continue;
		if (slot.status === "active") await stop(key.slice(prefix.length), slot);
		slot.status = "retired";
		slot.open = [];
	}

	// A project lane can ask or schedule an effect before it needs an agent.
	const anchor = async () => {
		if (work !== null) return work;
		p.anchor ??= (
			await tx.createConversation({ ownership: { kind: "ownerless" } })
		).id;
		return p.anchor;
	};
	const asking = new Map<string, string>();
	for (const ask of asks) {
		const subject = subjectKey(work, lane, ask.subject);
		const signature = createHash("sha256")
			.update(JSON.stringify([ask.title, ask.basis, ask.choices]))
			.digest("hex");
		if (asking.has(subject) && asking.get(subject) !== signature)
			throw new Error(`Conflicting asks for ${subject}`);
		asking.set(subject, signature);
		if (p.asks[subject]?.signature === signature) continue;
		const conversation = await anchor();
		const basis = await tx.appendEntry(basisEntry, conversation, {
			data: { text: ask.basis },
		});
		const d = await request(tx, {
			subject,
			title: ask.title,
			choices: ask.choices,
			basis,
			conversation,
			requestedAt: now,
			then: tasks.answer,
		});
		p.asks[subject] = {
			...address,
			local: ask.subject,
			decision: d.id,
			signature,
		};
	}
	for (const [subject, slot] of Object.entries(p.asks)) {
		if (slot.work !== work || slot.lane !== lane || asking.has(subject))
			continue;
		await withdraw(tx, subject);
		delete p.asks[subject];
	}

	const planned = new Set<string>();
	for (const effect of effects) {
		const key = slotKey(lane, effect.key);
		planned.add(key);
		if (slots.effects[key] && slots.effects[key].status !== "cancelled")
			continue;
		const home = await anchor();
		// A dispatch has its own abort scope. Stopping it must not stop the designer.
		const placement = effect.interruptible
			? {
					conversationId: (
						await tx.createConversation({ ownership: { kind: "ownerless" } })
					).id,
					ownership: { kind: "conversation" } as const,
				}
			: background(home);
		const task = await tx.createTask(
			tasks.effect,
			{ ...address, ...effect, root: frame.root },
			placement,
		);
		slots.effects[key] = {
			task,
			status: "planned",
			interrupt: effect.interruptible ? placement.conversationId : null,
		};
		await tx.createTask(
			tasks.effectResult,
			{ ...address, key: effect.key, task },
			background(home),
		);
	}
	for (const [key, slot] of Object.entries(slots.effects)) {
		if (!key.startsWith(prefix) || planned.has(key)) continue;
		if (slot.status === "planned") slot.status = "cancelled";
		// Project keys are not reused once retired. Keep claimed or stopping work
		// until its result task settles it; a late delivery checks the task identity.
		if (
			work === null &&
			(slot.status === "done" || slot.status === "cancelled")
		) {
			delete slots.effects[key];
			continue;
		}
		if (slot.status !== "running" || !slot.interrupt) continue;
		slot.status = "stopping";
		await tx.createTask(
			tasks.stop,
			{ effect: slot.interrupt },
			background(await anchor()),
		);
	}

	for (const note of frame.notes) {
		const conversation =
			note.agent === null
				? (work ?? p.anchor)
				: slots.agents[slotKey(lane, note.agent)]?.conversation;
		await emit(tx, eventEntry, {
			text: note.text,
			at: now,
			...(conversation != null && { conversation }),
		});
	}
}
