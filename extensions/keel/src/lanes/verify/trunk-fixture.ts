import type { WorkId } from "../../kernel/ids.ts";

// Include both an in-flight landing and a waiting work in the v1 contract.
export const trunkFixture = {
	version: 1,
	sample: (): { holder: WorkId | null; waiting: WorkId[] } => ({
		holder: 1 as WorkId,
		waiting: [2 as WorkId],
	}),
};
