import { createWorkflow } from "./workflow.ts";

export { KEEL_TELEMETRY_SCHEMA as telemetry } from "./kernel/metrics.ts";

export const { extension, entry, options } = createWorkflow();
