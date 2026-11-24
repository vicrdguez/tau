import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	createSqliteTelemetry,
	type SqliteTelemetry,
} from "@earendil-works/chord/telemetry-sqlite";
import {
	createTypedMetrics,
	defineTelemetrySchema,
} from "@earendil-works/pi-telemetry";
import type { AnsweredDecision } from "../store/types.js";
import { safeMessage } from "./task-reports.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const TAU_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		"tau.decision.wait": {
			kind: "histogram",
			unit: "ms",
			description: "Time from a decision's request to its accepted answer.",
			attributes: {
				task: {
					type: "string",
					required: true,
					cardinality: "low",
					description: "The decision's continuation task",
				},
				choice: {
					type: "string",
					required: true,
					cardinality: "low",
					description: "The accepted choice",
				},
			},
		},
	},
} as const);

export type Telemetry = {
	readonly adapter: SqliteTelemetry;
	recordAnswer(decision: AnsweredDecision): void;
	close(): Promise<void>;
};

export async function openTelemetry(
	file: string,
	project: string,
): Promise<Telemetry | undefined> {
	const report = (error: unknown) => {
		process.stderr.write(`tau: telemetry ${project}: ${safeMessage(error)}\n`);
	};
	const db = await openNodeSqliteDatabase(file).catch(report);
	if (db === undefined) return undefined;
	const adapter = await createSqliteTelemetry(db, {
		retentionMs: RETENTION_MS,
	}).catch(report);
	if (adapter === undefined) {
		await db.close().catch(report);
		return undefined;
	}
	const wait = createTypedMetrics(adapter.metrics, [
		TAU_TELEMETRY_SCHEMA,
	]).histogram("tau.decision.wait");
	return {
		adapter,
		recordAnswer(decision) {
			wait.record(decision.at - decision.requestedAt, {
				task: decision.then.task,
				choice: decision.choice,
			});
		},
		async close() {
			await adapter.close().catch(report);
			await db.close().catch(report);
		},
	};
}
