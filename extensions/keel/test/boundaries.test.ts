import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { posix as path } from "node:path";
import { test } from "node:test";

// The workspace check already rejects nonliteral module paths, require, import
// equals and relative imports without .ts. Check the Keel-specific rules here.
function violations(file: string, source: string): string[] {
	const [area, lane] = file.split("/");
	if (area !== "lanes" && area !== "dispatch") return [];
	const tokens = (
		source.match(
			/\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|[^\s]/g,
		) ?? []
	).filter((t) => !t.startsWith("//") && !t.startsWith("/*"));
	const errors = [];
	for (const [i, token] of tokens.entries()) {
		if (token !== "from" && token !== "import") continue;
		const literal = tokens[i + (tokens[i + 1] === "(" ? 2 : 1)];
		if (!literal || !/^["']/.test(literal)) continue;
		const spec = literal.slice(1, -1);
		const target = path.join(path.dirname(file), spec);
		const [targetArea, otherLane, ...rest] = target.split("/");
		let forbidden = false;
		if (!spec.startsWith(".")) {
			forbidden =
				spec === "tau-wf-keel" ||
				spec.startsWith("tau-wf-keel/") ||
				(area === "lanes" && (spec === "tau" || spec === "tau/durable"));
		} else if (area === "dispatch") {
			forbidden = targetArea !== "dispatch";
		} else if (targetArea === "kernel") {
			if (target === "kernel/state.ts") {
				// A side-effect import binds nothing; a namespace exposes stateDoc.
				if (token === "import" && tokens[i + 1] === literal) continue;
				const named = token === "from" && tokens[i - 1] === "}";
				const names = tokens.slice(tokens.lastIndexOf("{", i) + 1, i - 1);
				forbidden =
					!named ||
					names.some(
						(name, j) =>
							name.replace(/^["']|["']$/g, "") === "stateDoc" &&
							names[j - 1] !== "as",
					);
			} else {
				forbidden = target !== "kernel/ids.ts" && target !== "kernel/lane.ts";
			}
		} else if (
			file !== "lanes/index.ts" &&
			targetArea === "lanes" &&
			otherLane !== lane
		) {
			forbidden = rest.join("/") !== "public.ts";
		}
		if (forbidden) errors.push(`${file}: ${spec}`);
	}
	return errors;
}

test("allowed and forbidden Keel imports are distinguished even before the first lane ships", async () => {
	const fixtures: [string, string, boolean][] = JSON.parse(
		await readFile(
			new URL("./fixtures/boundaries.json", import.meta.url),
			"utf8",
		),
	);
	for (const [file, source, allowed] of fixtures) {
		assert.equal(
			violations(file, source).length,
			allowed ? 0 : 1,
			`${file}: ${source}`,
		);
	}
});

test("Keel lanes and dispatch stay within their import boundaries", async () => {
	const src = new URL("../src/", import.meta.url);
	const errors = [];
	for await (const file of glob("{lanes,dispatch}/**/*.ts", { cwd: src })) {
		errors.push(
			...violations(file, await readFile(new URL(file, src), "utf8")),
		);
	}
	assert.deepEqual(errors, []);
});
