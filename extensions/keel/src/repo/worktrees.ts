import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	branch,
	buildWork,
	Git,
	hasCode,
	key,
	layout,
	moved,
	occupied,
	oid,
	part,
	success,
} from "./git.ts";
import type {
	BranchName,
	Checkout,
	Remove,
	RepoInfo,
	Sha,
	Worker,
} from "./types.ts";

export function zlist(value: string) {
	return value.split("\0").filter(Boolean);
}

export async function touchedPaths(g: Git, from: string, to: Sha, globs?: readonly string[]) {
	if (globs?.length === 0 || from === to) return [];
	return zlist(await g.output(
		"diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none",
		"--name-only", "-z", oid(from), oid(to), "--",
		...(globs ?? []).map((glob) => ":(top,glob)" + glob),
	));
}

async function entries(g: Git) {
	const data = await g.output("worktree", "list", "--porcelain", "-z");
	return data
		.split("\0\0")
		.filter(Boolean)
		.map((record) =>
			Object.fromEntries(
				zlist(record).map((line) => {
					const cut = line.indexOf(" ");
					return cut < 0
						? [line, ""]
						: [line.slice(0, cut), line.slice(cut + 1)];
				}),
			),
		);
}
async function stat(path: string) {
	try {
		return await lstat(path);
	} catch (e) {
		if (hasCode(e, "ENOENT")) return null;
		throw e;
	}
}

/** No path supplied by a stored effect can escape the layout. Never follow a
 * symlink in it, including a substituted directory at a formerly locked path. */
function pathWork(repo: RepoInfo, path: string) {
	const [work, name, ...more] = relative(
		join(repo.commonDir, "keel"),
		path,
	).split(sep);
	if (
		!work ||
		!name ||
		more.length ||
		path !== join(repo.commonDir, "keel", part(work), part(name, true))
	)
		occupied(path);
	return work;
}

export function workerSpec(repo: RepoInfo, w: Worker) {
	const work = buildWork(w.from);
	if (
		pathWork(repo, w.path) !== work ||
		!/^keel\/[^/]+\/item\/[a-zA-Z0-9][a-zA-Z0-9._-]*-[1-9][0-9]*$/.test(
			w.branch,
		) ||
		!w.branch.startsWith("keel/" + work + "/item/")
	)
		throw new TypeError("invalid worker target");
	branch(w.branch);
	oid(w.base);
}
export async function freeBranch(g: Git, name: BranchName, integration?: string) {
	const entry = (await entries(g)).find(
		(e) => e.worktree !== integration && e.branch?.toLowerCase() === "refs/heads/" + name.toLowerCase(),
	);
	if (entry) occupied(entry.worktree!);
	// During rebase and bisect, porcelain reports a detached HEAD even
	// though Git reserves the original branch. update-ref bypasses this
	// protection. Inspect the same per-worktree state before using it.
	const linked = join(g.cwd, "worktrees");
	const admins = [g.cwd];
	if (await stat(linked)) {
		for (const id of await readdir(linked)) admins.push(join(linked, id));
	}
	const ref = "refs/heads/" + name;
	for (const admin of admins) {
		for (const file of [
			"rebase-merge/head-name",
			"rebase-apply/head-name",
			"rebase-merge/update-refs",
			"BISECT_START",
		]) {
			try {
				const lines = (await readFile(join(admin, file), "utf8"))
					.toLowerCase()
					.split("\n");
				if (
					lines.includes((file === "BISECT_START" ? name : ref).toLowerCase())
				)
					occupied(ref);
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error;
			}
		}
	}
}

function creationPrefix(name: BranchName) {
	return "keel create " + name + " ";
}

/** The checkouts and commits can outlive deletion/recreation of their
 * branches. Require Git's record for THIS name; a copied log isn't enough. */
export async function ownedBranch(g: Git, name: BranchName, effect?: string) {
	const prefix = creationPrefix(name);
	const log = await g.output(
		"reflog",
		"show",
		"-1",
		"--fixed-strings",
		"--grep-reflog=" + prefix,
		"--format=%gs",
		"refs/heads/" + name,
	);
	if (
		effect === undefined
			? !log.startsWith(prefix)
			: log !== prefix + effect + "\n"
	)
		occupied("refs/heads/" + name);
}

/** A creation can be interrupted between ref creation and checkout. A reflog
 * entry distinguishes that case from an unrelated branch at the same base. */
export async function creation(
	g: Git,
	name: BranchName,
	target: Sha,
	effect?: string,
) {
	const ref = "refs/heads/" + name,
		at = await g.head(name);
	if (at !== null) {
		if (at !== target) moved(at);
		const log = await g.output("reflog", "show", "-1", "--format=%gs", ref);
		if (effect === undefined ? !log.startsWith(creationPrefix(name)) : log !== creationPrefix(name) + effect + "\n")
			occupied(ref);
		return true;
	}
	const refs = (
		await g.output("for-each-ref", "--format=%(refname)", "refs/heads")
	).split("\n");
	if (
		refs.some((r) => r && (r.startsWith(ref + "/") || ref.startsWith(r + "/")))
	)
		occupied(ref);
	return false;
}

export async function advance(
	g: Git,
	name: BranchName,
	old: Sha | null,
	to: Sha,
	effect: string,
	sharedCreation = false,
) {
	const ref = "refs/heads/" + branch(name);
	await freeBranch(g, name);
	const r = await g.run(
		"update-ref",
		"--no-deref",
		"--create-reflog",
		"-m",
		(old === null ? creationPrefix(name) : "keel advance ") + key(effect),
		ref,
		oid(to),
		old === null ? "0".repeat(to.length) : oid(old),
	);
	if (r.code !== 0) {
		const actual = await g.head(name);
		if (actual === to) {
			if (old === null) await creation(g, name, to, sharedCreation ? undefined : effect);
			return;
		}
		if (actual !== old) moved(actual);
		if (/cannot lock ref|exists; cannot create/.test(r.stderr)) occupied(ref);
		success(r);
	}
}

export async function dirt(
	g: Git,
	mode: "publish" | "remove" | "remove_merged" | "proof" = "publish",
) {
	const out = await g.output(
		"status",
		"--porcelain=v1",
		"-z",
		"--no-renames",
		mode === "proof" ? "--untracked-files=no" : "--untracked-files=all",
		mode === "proof"
			? "--ignore-submodules=untracked"
			: "--ignore-submodules=none",
		...(mode === "remove" ? ["--ignored"] : []),
	);
	const files = zlist(out).map((line) => line.slice(3));
	// status trusts assume-unchanged and skip-worktree bits. It also cannot
	// certify the absence of ignored/private files INSIDE a submodule.
	const index = await g.output("ls-files", "-v", "--stage", "-z");
	const uncertain = zlist(index)
		.filter(
			(row) =>
				/^[a-zS]/.test(row) ||
				((mode === "remove" || mode === "remove_merged") &&
					row.startsWith("H 160000 ")),
		)
		.map((row) => row.slice(row.indexOf("\t") + 1));
	return [...new Set([...files, ...uncertain])];
}

function lockReason(target: Remove["target"]) {
	// A disposable checkout may attach to any branch. Never let its removal
	// policy apply to a worker, even if the caller mixes up their specs.
	return (
		(target.kind === "checkout" ? "keel checkout " : "keel ") + key(target.key)
	);
}

/** Registration + lock + both directions of Git's private gitdir link.
 * A stale registration alone proves nothing about the directory now there. */
export async function registered(g: Git, repo: RepoInfo, target: Remove["target"], allowDamaged = false) {
	const { path } = target;
	const work = pathWork(repo, path);
	for (const p of [join(repo.commonDir, "keel"), dirname(path), path]) {
		const s = await stat(p);
		if (s && !s.isDirectory()) occupied(path);
	}
	const matches = (await entries(g)).filter((e) => e.worktree === path);
	if (matches.length > 1) occupied(path);
	const entry = matches[0];
	const present = await stat(path);
	if (!present && !entry) return null;
	if (!entry || entry.locked !== lockReason(target) || "prunable" in entry)
		occupied(path);
	const dot = join(path, ".git");
	const admins = join(repo.commonDir, "worktrees");
	async function pointsTo(admin: string, link: string, expected: string) {
		const file = join(admin, link);
		return (await stat(file))?.isFile() &&
			resolve(admin, (await readFile(file, "utf8")).replace(/\n$/, "")) === expected;
	}
	async function linksMatch(admin: string) {
		return dirname(admin) === admins && !admin.includes("\0") &&
			(await stat(admin))?.isDirectory() && (await realpath(admin)) === admin &&
			await pointsTo(admin, "commondir", repo.commonDir) && await pointsTo(admin, "gitdir", dot);
	}
	if ((await stat(dot))?.isFile()) {
		const pointer = /^gitdir: (.+)\n?$/.exec(await readFile(dot, "utf8"));
		if (pointer) {
			const admin = resolve(path, pointer[1]!);
			if (await linksMatch(admin)) return {entry, admin, linked:true, present:true};
		}
	}
	// A missing forward link can prove only the *registration*, never a
	// directory at the old path. Only integration receipts/cleanup use this.
	if (allowDamaged && target.kind === "checkout" && path === layout.integration(repo, work, target.key)) {
		for (const id of await readdir(admins)) {
			const admin = join(admins, id);
			if (await linksMatch(admin)) return {entry, admin, linked:false, present:!!present};
		}
	}
	occupied(path);
}

export async function inspect(
	g: Git,
	repo: RepoInfo,
	target: Worker | Checkout,
) {
	const owned = await registered(g, repo, target);
	if (!owned) return null;
	const { entry, admin } = owned;
	const wt = new Git(g.exec, target.path);
	if (
		target.kind === "worktree" &&
		entry.branch !== "refs/heads/" + target.branch
	)
		occupied(target.path);
	const head = await wt.checkoutHead();
	if (head !== null && head !== entry.HEAD) moved(head);
	if (target.kind === "worktree") {
		if (head === null) moved(null);
		await ownedBranch(g, target.branch, target.key);
	}
	return { head, admin, wt, detached: "detached" in entry };
}

export async function ensureWorktree(
	g: Git,
	repo: RepoInfo,
	target: Worker | Checkout,
	createIfMissing = true,
) {
	if (target.kind === "worktree") workerSpec(repo, target);
	else oid(target.sha);
	let owned = await inspect(g, repo, target);
	if (!owned && !createIfMissing) occupied(target.path);
	if (target.kind === "worktree") {
		if (!owned) {
			const from = await g.head(target.from);
			if (from !== target.base) moved(from);
		}
		const exists = await creation(g, target.branch, target.base, target.key);
		if (!exists) await advance(g, target.branch, null, target.base, target.key);
		if (!owned) await freeBranch(g, target.branch);
	}
	if (!owned) {
		const r = await g.run(
			"worktree",
			"add",
			"--lock",
			"--reason",
			lockReason(target),
			...(target.kind === "checkout" ? ["--detach"] : []),
			"--",
			target.path,
			target.kind === "checkout" ? target.sha : target.branch,
		);
		if (r.code !== 0) {
			if (
				(await stat(target.path)) ||
				/already (?:checked out|used by worktree|registered)/.test(r.stderr)
			)
				occupied(target.path);
			success(r);
		}
		owned = await inspect(g, repo, target);
		if (!owned) occupied(target.path);
	}
	return owned;
}

export async function materialize(
	g: Git,
	repo: RepoInfo,
	target: Worker | Checkout,
) {
	const owned = await ensureWorktree(g, repo, target);
	if (target.kind === "checkout" && !owned.detached) occupied(target.path);
	if (owned.head !== (target.kind === "checkout" ? target.sha : target.base))
		moved(owned.head);
	if ((await dirt(owned.wt)).length) occupied(target.path);
	return owned;
}

export async function remove(
	g: Git,
	repo: RepoInfo,
	{ target, merged, mergedHead }: Remove,
) {
	if (target.kind === "worktree") {
		workerSpec(repo, target);
		const owned = await inspect(g, repo, target);
		if (!owned) return { kind: "removed" } as const;
		if (merged === true && mergedHead !== undefined && !(await g.ancestor(owned.head!, mergedHead)))
			return { kind: "kept", reason: "worker HEAD is not included in mergedHead", files: [] } as const;
		const files = await dirt(owned.wt, merged === true ? "remove_merged" : "remove");
		if (files.length)
			return {
				kind: "kept",
				reason: "worker has changes or files Git cannot certify are disposable",
				files,
			} as const;
	} else {
		const registration = await registered(g, repo, target, true);
		if (!registration) return { kind: "removed" } as const;
		if (!registration.linked && registration.present) occupied(target.path);
	}
	// One force permits a dirty disposable verifier; two are required for
	// a locked registration. Do not unlock first (that loses the proof).
	await g.output("worktree", "remove", "--force", "--force", "--", target.path);
	return { kind: "removed" } as const;
}

/** Read blobs, not paths on the host: neither a symlink nor an uncommitted
 * edit in a verifier can supply project prose. Parsing bindings belongs to prose. */
export async function markdown(g: Git, at: Sha, dir: string) {
	const blobs = await g.output("ls-tree", "-z", oid(at), "--", dir + "/");
	const files: { name: string; body: string }[] = [];
	for (const row of zlist(blobs)) {
		const m = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/.exec(row);
		if (!m) continue;
		const name = m[2]!.slice(dir.length + 1);
		if (name.includes("/") || !name.endsWith(".md")) continue;
		files.push({
			name: name.slice(0, -3),
			body: await g.output("cat-file", "blob", m[1]!),
		});
	}
	return files;
}
