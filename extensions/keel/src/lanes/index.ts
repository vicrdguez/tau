import { buildLane, buildTools } from "./build/index.ts";
import { designLane, designTools } from "./design/index.ts";
import { queueLane, queueTools } from "./queue/index.ts";
import { verifyLane, verifyTools } from "./verify/index.ts";
import { trunkLane } from "./verify/trunk.ts";

export const lanes = [designLane, buildLane, verifyLane, trunkLane, queueLane];
export const tools = [
	...designTools,
	...buildTools,
	...verifyTools,
	...queueTools,
];
