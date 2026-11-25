import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { post, until } from "./journey.ts";

const tau = fileURLToPath(
	new URL("./command/main.js", import.meta.resolve("tau/server")),
);
const running: ChildProcess[] = [];
after(() => {
	for (const child of running) child.kill("SIGKILL");
});
async function home() {
	const dir = await mkdtemp(path.join(tmpdir(), "tau-command-"));
	return {
		HOME: dir,
		PI_CODING_AGENT_DIR: path.join(dir, "pi"),
		PATH: process.env.PATH ?? "",
	};
}
function run(env: NodeJS.ProcessEnv, args: string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>(
		(resolve) => {
			execFile(
				process.execPath,
				[tau, ...args],
				{ env },
				(error, stdout, stderr) => {
					resolve({
						code: error === null ? 0 : Number(error.code ?? 1),
						stdout,
						stderr,
					});
				},
			);
		},
	);
}
async function serve(env: NodeJS.ProcessEnv, args: string[] = []) {
	const child = spawn(process.execPath, [tau, "--port", "0", ...args], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	running.push(child);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	await until("command listening address", () => {
		if (child.exitCode !== null) assert.fail(`tau exited: ${stderr}`);
		return stdout.includes("listening");
	});
	const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
	assert.ok(url, stdout);
	assert.ok(!url.endsWith(":0"));
	return { child, url, output: () => ({ stdout, stderr }) };
}

async function pair(env: NodeJS.ProcessEnv, url: string, device: string) {
	const issued = await run(env, ["device", "pair", device]);
	assert.equal(issued.code, 0, issued.stderr);
	const code = /[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(issued.stdout)?.[0];
	assert.ok(code, issued.stdout);
	const paired = await post(url, "pair", { code });
	return paired.body.result.token as string;
}

test("tau starts empty and discovers only the extensions placed in its home", async () => {
	const env = await home();
	const empty = await serve(env);
	try {
		const token = await pair(env, empty.url, "empty");
		assert.deepEqual(
			(await post(empty.url, "extensions", {}, token)).body.result.items,
			[],
		);
	} finally {
		empty.child.kill("SIGTERM");
		assert.equal((await once(empty.child, "exit"))[0], 0);
	}
	const folder = path.join(env.HOME, ".tau", "extensions", "local");
	await mkdir(folder, { recursive: true });
	await writeFile(
		path.join(folder, "index.ts"),
		`import { defineExtension } from "tau/durable";\nexport const extension = defineExtension({name: "local"});\n`,
	);
	const loaded = await serve(env);
	try {
		const token = await pair(env, loaded.url, "loaded");
		assert.deepEqual(
			(await post(loaded.url, "extensions", {}, token)).body.result.items,
			[{ name: "local", workflow: false }],
		);
	} finally {
		loaded.child.kill("SIGTERM");
		assert.equal((await once(loaded.child, "exit"))[0], 0);
	}
});

test("tau restores its own offline catalog and runs a conversation with a restored model", async (t) => {
	const env = await home();
	const tauHome = path.join(env.HOME, ".tau");
	await mkdir(tauHome);
	await mkdir(env.PI_CODING_AGENT_DIR);
	let requested: string | undefined;
	const provider = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requested = JSON.parse(body).model;
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(
			'data: {"choices":[{"index":0,"delta":{"content":"catalog reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		);
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	t.after(() => provider.close());
	const address = provider.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	const store = (id: string) =>
		JSON.stringify({
			openrouter: {
				models: [
					{
						provider: "openrouter",
						api: "openai-completions",
						baseUrl,
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						contextWindow: 65536,
						maxTokens: 1024,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		});
	const id = "example/future-chat";
	for (const [home, cached, configured] of [
		[tauHome, id, "tau-config"],
		[env.PI_CODING_AGENT_DIR, "example/pi-cache", "pi-config"],
	] as const) {
		await writeFile(path.join(home, "models-store.json"), store(cached));
		await writeFile(
			path.join(home, "models.json"),
			JSON.stringify({
				providers: {
					[configured]: {
						api: "openai-completions",
						baseUrl,
						apiKey: "fixture",
						models: [{ id: "chat" }],
					},
				},
			}),
		);
	}
	await writeFile(
		path.join(env.PI_CODING_AGENT_DIR, "auth.json"),
		JSON.stringify({ openrouter: { type: "api_key", key: "fixture" } }),
	);
	const server = await serve(env);
	try {
		const token = await pair(env, server.url, "catalog");
		const call = async (name: string, args: object) => {
			const reply = await post(server.url, name, args, token);
			assert.equal(reply.status, 200, JSON.stringify(reply.body));
			return reply.body.result;
		};
		const model = `openrouter/${id}`;
		const { items } = await call("models", {});
		const names = items.map((item: { model: string }) => item.model);
		assert.ok(names.includes(model), `missing ${model}`);
		assert.ok(names.includes("tau-config/chat"));
		assert.ok(!names.includes("openrouter/example/pi-cache"));
		assert.ok(!names.includes("pi-config/chat"));
		await call("bind", { project: "p", workdir: env.HOME, extensions: [] });
		const { conversation } = await call("create", { project: "p", model });
		await call("input", {
			project: "p",
			conversation,
			text: "hello",
			requestId: "r1",
		});
		await until("restored model replies", async () =>
			JSON.stringify(
				await call("history", { project: "p", conversation }),
			).includes("catalog reply"),
		);
		assert.equal(requested, id);
	} finally {
		server.child.kill("SIGTERM");
		assert.equal((await once(server.child, "exit"))[0], 0);
	}
});

test("reload rereads prose, refuses syntax errors and keeps the old workflow without exposing secrets", async () => {
	const env = await home();
	const server = await serve(env);
	const folder = path.join(env.HOME, ".tau", "extensions", "local");
	await mkdir(folder);
	const source = `import { defineExtension } from "tau/durable";
import { options as defineOptions, prose } from "tau";
import { obj, str } from "tau/schema";
export const extension = defineExtension({name: "local"});
export const options = defineOptions("local", obj({key: str({format: "secret"})}));
const instructions = prose(import.meta.dirname, "agent.md", [])({});
export const entry = {model: {provider: "anthropic", modelId: "claude-sonnet-4-5"}, extensions: [extension], instructions};
`;
	try {
		const token = await pair(env, server.url, "reload");
		await writeFile(path.join(folder, "index.ts"), source);
		await writeFile(path.join(folder, "agent.md"), "old prose");
		const added = await run(env, ["extension", "reload"]);
		assert.equal(added.code, 0, added.stderr);
		assert.match(added.stdout, /added local; projects: none/);
		await post(
			server.url,
			"bind",
			{ project: "p", workdir: env.HOME, extensions: ["local"] },
			token,
		);
		const secret = "R8-SECRET-NEVER-PRINT";
		await post(
			server.url,
			"setOptions",
			{ project: "p", extension: "local", patch: { key: secret } },
			token,
		);
		await writeFile(path.join(folder, "agent.md"), "new prose");
		const replaced = await run(env, ["extension", "reload"]);
		assert.equal(replaced.code, 0, replaced.stderr);
		assert.match(replaced.stdout, /replaced local; projects: p/);
		await writeFile(path.join(folder, "index.ts"), "export const broken = ;");
		const refused = await run(env, ["extension", "reload"]);
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /refused; old code still runs/);
		const created = await post(
			server.url,
			"create",
			{ project: "p", workflow: "local" },
			token,
		);
		assert.equal(
			typeof created.body.result.conversation,
			"number",
			JSON.stringify(created.body),
		);
		assert.doesNotMatch(
			[added, replaced, refused].map((r) => r.stdout + r.stderr).join("") +
				JSON.stringify(server.output()),
			new RegExp(secret),
		);
	} finally {
		server.child.kill("SIGTERM");
		assert.equal((await once(server.child, "exit"))[0], 0);
	}
});
