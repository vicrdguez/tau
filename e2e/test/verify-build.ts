import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	access,
	chmod,
	cp,
	glob,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const [command, ...outputs] = process.argv.slice(2);
assert.ok(command, "Pass the installed tau executable.");
assert.equal(
	outputs.length,
	4,
	"Pass the keel, w1, w2 and websearch source outputs.",
);
const [keelSource, w1Source, w2Source] = outputs as [string, string, string];
const root = await mkdtemp(join(tmpdir(), "tau-installed-"));
const home = join(root, ".tau");
const env = {
	...process.env,
	HOME: root,
	PI_CODING_AGENT_DIR: join(root, "pi"),
};
const run = promisify(execFile);
const lib = resolve(command, "../../lib/tau");

async function post(url: string, name: string, body: object, token?: string) {
	const response = await fetch(`${url}/v1/${name}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const reply = await response.json();
	assert.equal(response.status, 200, JSON.stringify(reply));
	return reply.result;
}

async function check(initial: "empty" | "writable" | "file" = "empty") {
	const child = spawn(command!, ["--port", "0"], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		const deadline = Date.now() + 60_000;
		while (!stdout.includes("listening")) {
			assert.equal(child.exitCode, null, stderr);
			assert.ok(
				Date.now() < deadline,
				`installed tau did not start: ${stderr}`,
			);
			await new Promise((done) => setTimeout(done, 10));
		}
		process.stdout.write(stdout);
		const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
		assert.ok(url);
		const device = "phone";
		const paired = await run(command!, ["device", "pair", device], { env });
		const code = /[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(paired.stdout)?.[0];
		assert.ok(code);
		const { token } = await post(url, "pair", { code });
		assert.deepEqual(
			(await post(url, "extensions", {}, token)).items.map(
				(item: { name: string }) => item.name,
			),
			initial === "writable" ? ["w2"] : [],
			stderr,
		);
		if (initial === "file") {
			assert.ok(stderr.includes(join(home, "extensions")), stderr);
			assert.match(stderr, /not a folder/);
			process.stdout.write(
				"extensions path is a file; reported on stderr; extensions []\n",
			);
			return;
		}
		if (initial === "writable") {
			assert.equal(stderr, "");
			process.stdout.write(
				"extensions mode 0777; copied W2 files mode 0664; loaded w2\n",
			);
			return;
		}
		process.stdout.write("empty extensions []\n");
		for (const [i, name] of ["keel", "w1", "w2", "websearch"].entries()) {
			const output = outputs[i]!;
			await access(join(output, "index.ts"));
			for await (const file of glob("**/*.{js,mjs,cjs}", {
				cwd: output,
				exclude: ["node_modules/**"],
			}))
				assert.fail(`extension ships JavaScript: ${file}`);
			await symlink(output, join(home, "extensions", name));
		}
		const added = await run(command!, ["extension", "reload"], { env });
		assert.equal(
			added.stdout.split("\n").filter((line) => line.startsWith("added "))
				.length,
			4,
			added.stdout,
		);
		process.stdout.write(added.stdout);
		const { items } = await post(url, "extensions", {}, token);
		{
			assert.deepEqual(
				items.map((item: any) => [item.name, item.workflow]),
				[
					["keel", true],
					["w1", true],
					["w2", true],
					["websearch", false],
				],
				stderr,
			);
			assert.deepEqual(
				items.map((item: any) =>
					item.name === "keel"
						? item.schema.required
								.filter(
									(key: string) => !("default" in item.schema.properties[key]),
								)
								.sort()
						: item.schema.required,
				),
				[
					["build", "design", "queue", "verify"],
					["designer", "implementer", "reviewer", "base"],
					["model"],
					["provider", "apiKey"],
				],
			);
			assert.ok(
				items.every(
					(item: any) =>
						item.schema.type === "object" &&
						item.schema.additionalProperties === false,
				),
			);
			for (const [name, property] of Object.entries<{ format?: string }>(
				items[0].schema.properties,
			)) {
				if (
					![
						"base",
						"trunk",
						"max_workers",
						"dispatch_rounds",
						"dispatch_minutes",
						"sweep_minutes",
					].includes(name)
				)
					assert.equal(property.format, "model", `keel option ${name}`);
			}
			assert.equal(items[1].schema.properties.designer.format, "model");
			assert.equal(items[2].schema.properties.model.format, "model");
			assert.equal(items[3].schema.properties.apiKey.format, "secret");
			process.stdout.write(
				"loaded keel, w1, w2, websearch with options schemas\n",
			);
			const bound = await post(
				url,
				"bind",
				{ project: "p", workdir: root, extensions: ["w2", "websearch"] },
				token,
			);
			assert.deepEqual(bound.project.missing, []);
			const projects = await post(url, "projects", {}, token);
			assert.deepEqual(projects.items[0].missing, []);
			await post(
				url,
				"setOptions",
				{
					project: "p",
					extension: "w2",
					patch: { model: "anthropic/claude-sonnet-4-5" },
				},
				token,
			);
			const created = await post(
				url,
				"create",
				{ project: "p", workflow: "w2" },
				token,
			);
			assert.equal(typeof created.conversation, "number");
			process.stdout.write(
				"project missing []; W2 conversation created without a model call\n",
			);
		}
		const changed = join(root, "changed-w2");
		await cp(w2Source, changed, { recursive: true, dereference: false });
		await chmod(changed, 0o777);
		const prose = join(changed, "agent.md");
		await chmod(prose, 0o664);
		await writeFile(
			prose,
			(await readFile(prose, "utf8")) + "\nRELOADED-MARKDOWN.\n",
		);
		await rm(join(home, "extensions", "w2"));
		await symlink(changed, join(home, "extensions", "w2"));
		const replaced = await run(command!, ["extension", "reload"], { env });
		assert.match(replaced.stdout, /^replaced w2; projects: p$/m);
		process.stdout.write(replaced.stdout);
		const models = await post(url, "models", {}, token);
		assert.ok(Array.isArray(models.items));
		const listed = await run(command!, ["device", "list"], { env });
		assert.match(listed.stdout, new RegExp(device));
		process.stdout.write("models HTTP 200; paired device listed\n");
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exit = once(child, "exit", { signal: AbortSignal.timeout(60_000) });
			child.kill("SIGTERM");
			const [code, signal] = await exit;
			assert.equal(code, 0, stderr);
			assert.equal(signal, null);
			process.stdout.write("SIGTERM exit 0\n");
		}
	}
}

try {
	assert.deepEqual((await readdir(lib)).sort(), [
		"core",
		"node_modules",
		"package.json",
	]);
	assert.ok(
		(await readdir(join(lib, "core", "dist", "src"))).includes("server.js"),
	);
	for await (const file of glob("**/*", {
		cwd: resolve(command, "../.."),
		exclude: ["**/node_modules", "**/node_modules/**"],
	})) {
		assert.ok(!file.endsWith(".md"), `core ships prose: ${file}`);
		assert.ok(
			!file.endsWith(".ts") || file.endsWith(".d.ts"),
			`core ships TypeScript source: ${file}`,
		);
		if (!/\.(?:js|json)$/.test(file)) continue;
		assert.doesNotMatch(
			await readFile(resolve(command, "../..", file), "utf8"),
			/tau-wf-keel|tau-w1|tau-w2|tau-websearch/,
			file,
		);
	}
	const directory = join(home, "extensions");
	await mkdir(directory, { recursive: true });
	await chmod(directory, 0o777);
	await check();
	await rm(home, { recursive: true });
	await mkdir(directory, { recursive: true });
	await chmod(directory, 0o777);
	const copied = join(directory, "w2");
	await cp(w2Source, copied, { recursive: true });
	await chmod(copied, 0o775);
	for await (const file of glob("**/*.{ts,md}", { cwd: copied }))
		await chmod(join(copied, file), 0o664);
	await check("writable");
	await rm(home, { recursive: true });
	await mkdir(home);
	await writeFile(directory, "");
	await check("file");
	for (const file of [
		"build",
		"designer",
		"fix",
		"implementer",
		"retry",
		"review",
		"reviewer",
		"revise",
	])
		assert.ok(
			(await readFile(join(w1Source, `${file}.md`), "utf8")).length > 0,
		);
	assert.ok((await readFile(join(w2Source, "agent.md"), "utf8")).length > 0);
	for (const file of [
		"roles/designer",
		"inputs/build/brief",
		"documents/mandate",
		"principles/prove-it-works",
		"playbooks/architect/rationale-template",
	])
		assert.ok(
			(await readFile(join(keelSource, "prose", `${file}.md`), "utf8")).length >
				0,
		);
	process.stdout.write("extension source and Markdown installed\n");
} finally {
	await rm(root, { recursive: true, force: true });
}
