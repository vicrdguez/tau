import { writeSync } from "node:fs";
import type { Storage } from "tau/durable";

// Kill only after SQLite stores the selected delivery, before the harness can run it.
export function killAfterDelivery(
	sqlite: Storage,
	point: string,
	matches: (input: unknown) => boolean = () => true,
): Storage {
	return new Proxy(sqlite, {
		get(target, key) {
			if (key !== "commit") {
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args: Parameters<Storage["commit"]>) => {
				const result = await target.commit(...args);
				if (
					args[0]
						.slice(0, result.stored)
						.flat()
						.some(
							(w) =>
								w.type === "task" &&
								w.value.kind === "keel.deliver" &&
								matches(w.value.input),
						)
				) {
					writeSync(1, `kill:${point}\n`);
					process.kill(process.pid, "SIGKILL");
				}
				return result;
			};
		},
	});
}
