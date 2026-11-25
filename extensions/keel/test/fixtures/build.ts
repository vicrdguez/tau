// Bring a pure Build lane to planning with explicit discovery/start results.
// Callers own the Mandate, later actions, and every expected outcome.
import type { JsonObject } from "tau/durable";
import type { LaneEvent } from "../../src/kernel/lane.ts";
import type { Mandate } from "../../src/lanes/design/public.ts";

export function startBuild(
	lane: { send(event: LaneEvent): unknown; done(result: LaneEvent): unknown },
	mandate: Mandate,
	repo: JsonObject & { trunkHead: string },
) {
	lane.send({ kind: "bound", mandate });
	lane.done({ kind: "repo", repo });
	lane.done({ kind: "started", base: repo.trunkHead });
}
