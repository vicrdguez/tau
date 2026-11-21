import { effectKey } from "../../kernel/ids.ts";
import type {
	Accepted,
	EffectDecl,
	KernelEvent,
	World,
} from "../../kernel/lane.ts";
import type { Sha, Worker } from "../../repo/index.ts";
import type { Build } from "./state.ts";

function completion(state: Build, w: World): Accepted<Build> {
	return state.waitingSetup || state.cleanup.length
		? { state }
		: {
				state,
				send: [
					{
						lane: "design",
						work: w.work,
						event: {
							kind: "cleanup_finished",
							lane: "build",
							kept: state.kept,
						},
					},
				],
			};
}
export function cancel(
	s: Build,
	w: World,
	plans: { item: string | null; effect: EffectDecl }[],
) {
	s.phase = "cancelled";
	function claimed(item: string | null) {
		const effect = plans.find((p) => p.item === item)?.effect;
		return effect && w.runningEffect?.(effect.key) ? effect.key : null;
	}
	s.waitingSetup = claimed(null);
	function collect(
		worker: Worker,
		mergedHead: Sha | null,
		wait: string | null,
		key = `cancel/remove/${worker.key}`,
	) {
		s.cleanup.push({ worker, mergedHead, wait, key });
	}
	for (const worker of s.abandoned) collect(worker, null, null);
	for (const i of s.items) {
		if (!i.worker) continue;
		const running = claimed(i.id);
		// Once claimed, a creation can still write its path. Do not race it with removal.
		// A held or interrupted creation may already have left a checkout there.
		collect(
			i.worker,
			i.mergedHead,
			i.stage === "preparing" ? running : null,
			i.stage === "cleaning" && running ? running : undefined,
		);
	}
	return completion(s, w);
}
export function cleanupEffects(s: Build): EffectDecl[] {
	return s.cleanup
		.filter((j) => !j.wait)
		.map(({ key, worker, mergedHead }) => ({
			key: effectKey(key),
			spec: {
				repo: s.repo!,
				op: {
					kind: "remove",
					key: `remove:${worker.key}`,
					target: worker,
					...(mergedHead ? { merged: true, mergedHead } : {}),
				},
			},
		}));
}
export function settleCleanup(
	s: Build,
	e: KernelEvent,
	w: World,
): Accepted<Build> {
	if (e.kind !== "effect_done" && e.kind !== "effect_failed")
		return { state: s };
	if (s.waitingSetup === e.key) {
		s.waitingSetup = null;
		return completion(s, w);
	}
	const j = s.cleanup.find((j) => j.wait === e.key || j.key === e.key);
	if (!j) return { state: s };
	if (j.wait === e.key) {
		j.wait = null;
		return { state: s };
	}
	const kept =
		e.kind === "effect_failed" || e.result.kind !== "removed"
			? `${j.worker.path}: ${e.kind === "effect_failed" ? e.error : JSON.stringify(e.result)}`
			: null;
	if (kept) s.kept.push(kept);
	s.cleanup = s.cleanup.filter((other) => other !== j);
	if (s.phase === "cancelled") return completion(s, w);
	return kept
		? { state: s, notes: [{ agent: null, text: `Kept ${kept}` }] }
		: { state: s };
}
