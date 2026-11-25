import type { Context } from "tau/chord";
import type { HarnessOptions } from "tau/durable";

type Span = Context["telemetry"];
type Attributes = Parameters<Span["setAttributes"]>[0];

export function captureTelemetry(fail = false) {
	const spans: { name: string; attributes: Attributes }[] = [];
	const samples: {
		kind: "counter" | "histogram";
		name: string;
		unit: string | undefined;
		value: number;
		attributes: Attributes | undefined;
	}[] = [];
	const telemetry: NonNullable<HarnessOptions["telemetry"]> = {
		async startSpan({ name, attributes }, run) {
			const span = { name, attributes: { ...attributes } };
			spans.push(span);
			return run({
				...telemetry,
				addLink() {},
				addEvent() {},
				setAttributes(attrs) {
					Object.assign(span.attributes, attrs);
				},
				setStatus() {},
			});
		},
		metrics: {
			counter(name, options) {
				return {
					add(value, attributes) {
						samples.push({
							kind: "counter",
							name,
							unit: options?.unit,
							value,
							attributes,
						});
						if (fail) throw new Error("telemetry adapter failed");
					},
				};
			},
			histogram(name, options) {
				return {
					record(value, attributes) {
						samples.push({
							kind: "histogram",
							name,
							unit: options?.unit,
							value,
							attributes,
						});
					},
				};
			},
			upDownCounter: () => ({ add() {} }),
		},
	};
	return { telemetry, spans, samples };
}
