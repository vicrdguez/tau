import assert from "node:assert/strict";
import { test } from "node:test";
import { telemetry } from "../src/index.ts";
import type { Measure } from "../src/kernel/metrics.ts";

type Names = keyof typeof telemetry.metrics;
type Assert<T extends true> = T;

export type MeasureContract = [
	Assert<Exclude<Names, Measure["name"]> extends never ? true : false>,
	Assert<Exclude<Measure["name"], Names> extends never ? true : false>,
	Assert<
		{ name: "keel.unknown"; value: 1; attributes: {} } extends Measure
			? false
			: true
	>,
	Assert<
		{
			name: "keel.work.started";
			value: 1;
			attributes: { route: "arbitrary" };
		} extends Measure
			? false
			: true
	>,
	Assert<
		{
			name: "keel.item.reviews";
			value: 1;
			attributes: { id: "123" };
		} extends Measure
			? false
			: true
	>,
];

test("Keel exports a telemetry schema namespaced to its extension", () => {
	const metrics = Object.keys(telemetry.metrics);
	assert.ok(metrics.includes("keel.decision.wait"));
	for (const name of [...metrics, ...Object.keys(telemetry.spans)])
		assert.match(name, /^keel\./);
});
