import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BranchName, Obstruction, RepoInfo, Sha } from "./types.ts";

type Output = { code: number; stdout: string; stderr: string };
/** env REPLACES the inherited environment. For a timed check kill its process group,
 * and retain only trailing output. Git output, in contrast, must never be truncated. */
export type Exec = (
	argv: readonly string[],
	cwd: string,
	options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<Output>;

export const nodeExec: Exec = (argv, cwd, { env, timeoutMs }) =>
	new Promise((resolve, reject) => {
		const proof = timeoutMs !== undefined;
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd,
			env,
			detached: proof,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [],
			err: Buffer[] = [];
		let timedOut = false;
		function killProofGroup() {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (!hasCode(error, "ESRCH")) reject(error);
			}
		}
		let exited = false;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		function stopWaiting() {
			timedOut = true;
			if (!exited) killProofGroup();
			child.stdout.destroy();
			child.stderr.destroy();
		}
		const timer = proof ? setTimeout(stopWaiting, timeoutMs) : undefined;
		// "close" waits for inherited pipes. Stop any surviving group members
		// when the command exits, before waiting for its trailing output.
		if (proof)
			child.once("exit", () => {
				exited = true;
				if (!timedOut) {
					killProofGroup();
					drainTimer = setTimeout(stopWaiting, 250);
				}
			});
		function collect(parts: Buffer[], bytes: Buffer) {
			if (!proof) parts.push(bytes);
			else
				parts[0] = Buffer.concat([parts[0] ?? Buffer.alloc(0), bytes]).subarray(
					-4096,
				);
		}
		child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			if (proof) resolve({ code: 127, stdout: "", stderr: error.message });
			else reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(drainTimer);
			clearTimeout(timer);
			try {
				resolve({
					code: timedOut ? 124 : (code ?? 1),
					stdout: new TextDecoder("utf-8", {
						fatal: !proof,
						ignoreBOM: true,
					}).decode(Buffer.concat(out)),
					stderr:
						Buffer.concat(err).toString() +
						(timedOut ? "\ncheck timed out" : ""),
				});
			} catch (error) {
				reject(error);
			}
		});
	});

export function hasCode(error: unknown, code: string) {
	return error instanceof Error && "code" in error && error.code === code;
}
export function environment(): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
		),
		LC_ALL: "C",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_GRAFT_FILE: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_AUTHOR_NAME: "Keel",
		GIT_AUTHOR_EMAIL: "keel@localhost",
		GIT_COMMITTER_NAME: "Keel",
		GIT_COMMITTER_EMAIL: "keel@localhost",
	};
}

export function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
export function oid(output: string): string {
	const value = output.replace(/\n$/, "");
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
		throw new Error("not a full git object id");
	return value;
}
export function key(value: string) {
	if (!/^[!-~]+$/.test(value)) throw new TypeError("invalid effect key");
	return value;
}
export function part(value: string, spaces = false) {
	if (
		!(
			spaces ? /^[a-zA-Z0-9][a-zA-Z0-9. _-]*$/ : /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
		).test(value) ||
		value.includes("..") ||
		/[. ]$|\.lock$/i.test(value)
	)
		throw new TypeError("invalid layout component: " + value);
	return value;
}
export function branch(value: string): BranchName {
	for (const component of value.split("/")) part(component);
	return value as BranchName;
}

export const layout = {
	buildBranch(work: string) {
		return branch("keel/" + part(work) + "/build");
	},
	itemBranch(work: string, item: string, attempt: number) {
		if (!Number.isSafeInteger(attempt) || attempt < 1)
			throw new TypeError("invalid attempt");
		return branch("keel/" + part(work) + "/item/" + part(item) + "-" + attempt);
	},
	worktree(repo: RepoInfo, work: string, name: string) {
		return join(repo.commonDir, "keel", part(work), part(name, true));
	},
	integration(repo: RepoInfo, work: string, effect: string) {
		return this.worktree(repo, work, "integration-" + hash(key(effect)));
	},
};
export function buildWork(name: BranchName) {
	const m = /^keel\/([^/]+)\/build$/.exec(name);
	if (!m || layout.buildBranch(m[1]!) !== name)
		throw new TypeError("not a build branch");
	return m[1]!;
}

class Obstructed extends Error {
	readonly result: Obstruction;
	constructor(result: Obstruction) {
		super(result.kind + " " + JSON.stringify(result));
		this.result = result;
	}
}
export function occupied(path: string): never {
	throw new Obstructed({ kind: "occupied", path });
}
export function moved(actual: Sha | null): never {
	throw new Obstructed({ kind: "moved", actual });
}
export async function report<T>(
	action: () => Promise<T>,
): Promise<T | Obstruction> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof Obstructed) return error.result;
		throw error;
	}
}
export function success(r: Output) {
	if (r.code !== 0) throw Error("git: " + r.stderr.trimEnd());
	return r.stdout;
}

export class Git {
	readonly exec: Exec;
	readonly cwd: string;
	constructor(exec: Exec, cwd: string) {
		this.exec = exec;
		this.cwd = cwd;
	}
	run(...args: string[]) {
		return this.exec(
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.attributesFile=/dev/null",
				"-c",
				"core.excludesFile=/dev/null",
				"-c",
				"maintenance.auto=false",
				"-c",
				"gc.auto=0",
				...args,
			],
			this.cwd,
			{ env: environment() },
		);
	}
	async output(...args: string[]) {
		return success(await this.run(...args));
	}
	async head(name: BranchName) {
		const ref = "refs/heads/" + branch(name);
		// rev-parse does revision DWIM even on a fully qualified name: a tag
		// called refs/heads/trunk must never stand in for a missing branch.
		const r = await this.run(
			"for-each-ref",
			"--count=1",
			"--format=%(refname) %(objectname) %(objecttype) %(symref)",
			ref,
		);
		const [found, sha, type, symbolic] = success(r).trimEnd().split(" ");
		if (r.stderr) occupied(ref);
		if (found === ref) {
			if (symbolic || type !== "commit") occupied(ref);
			return oid(sha!) as Sha;
		}
		// A dangling symref is omitted from for-each-ref, but isn't ours to replace.
		const dangling = await this.run("symbolic-ref", "-q", ref);
		if (dangling.code === 0) occupied(ref);
		if (dangling.code !== 1) success(dangling);
		return null;
	}
	async checkoutHead(): Promise<Sha | null> {
		const r = await this.run(
			"rev-parse",
			"--verify",
			"--quiet",
			"HEAD^{commit}",
		);
		return r.code === 1 ? null : (oid(success(r)) as Sha);
	}
	async ancestor(older: Sha, newer: Sha) {
		const r = await this.run(
			"merge-base",
			"--is-ancestor",
			oid(older),
			oid(newer),
		);
		if (r.code === 1) return false;
		success(r);
		return true;
	}
	async commit(tree: string, parents: Sha[], effect: string, message: string) {
		// Stable identity, zone and date; unlike a trailer alone the resulting id
		// binds the entire tree, ordered parents, key and intended message.
		const date =
			(await this.output("show", "-s", "--format=%ct", parents[0]!)).trim() +
			" +0000";
		const env = {
			...environment(),
			GIT_AUTHOR_DATE: "@" + date,
			GIT_COMMITTER_DATE: "@" + date,
		};
		return oid(
			success(
				await this.exec(
					[
						"git",
						"-c",
						"commit.gpgSign=false",
						"commit-tree",
						oid(tree),
						...parents.flatMap((p) => ["-p", oid(p)]),
						"-m",
						message,
						"-m",
						"Keel-Effect: " + key(effect),
					],
					this.cwd,
					{ env },
				),
			),
		) as Sha;
	}
}
