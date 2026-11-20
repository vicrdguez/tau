import type { ConversationId } from "tau/durable";

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type WorkId = Brand<ConversationId, "WorkId">;
export type AgentKey = Brand<string, "AgentKey">;
export type EffectKey = Brand<string, "EffectKey">;
export type SubjectLocal = Brand<string, "SubjectLocal">;
export type Token = Brand<string, "Token">;

export const workId = (id: ConversationId) => id as WorkId;
export const agentKey = (name: string) => name as AgentKey;
export const effectKey = (name: string) => name as EffectKey;
export const subject = (name: string) => name as SubjectLocal;
export const token = (situation: string, sequence: number) =>
	`${situation}@${sequence}` as Token;

// Escape lane names once so local keys (including "/" and ":") remain opaque.
export const slotKey = (lane: string, local: string) =>
	`${encodeURIComponent(lane)}:${local}`;
export const subjectKey = (
	work: WorkId | null,
	lane: string,
	local: SubjectLocal,
) => `keel:${work ?? "project"}:${slotKey(lane, local)}`;
