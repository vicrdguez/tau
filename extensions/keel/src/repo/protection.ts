import { type Git, oid, success } from "./git.ts";
import type { ProtectedChange, Protection, Sha } from "./types.ts";
import { touchedPaths, zlist } from "./worktrees.ts";

export function isPolicyPath(path: string) {
	return /^\.keel(?:\/|$)/i.test(path);
}

export function protectedViolations(
	changes: readonly ProtectedChange[],
	reviewedEncode: boolean,
) {
	return changes.filter(
		(c) => isPolicyPath(c.path) || (!reviewedEncode && c.kind !== "added"),
	);
}

export function holds(
	changes: readonly ProtectedChange[],
	policy: Protection,
	candidate: Sha,
) {
	return protectedViolations(changes, policy.reviewedEncode).some(
		(c) =>
			isPolicyPath(c.path) ||
			(policy.allowedCandidate !== candidate &&
				!policy.allowedChanges.some(
					(a) =>
						a.path === c.path &&
						a.kind === c.kind &&
						a.before === c.before &&
						a.after === c.after,
				)),
	);
}

/** Construct a reproducible comparison object without changing a ref or checkout.
 * A worker can have inherited independently from both build and the sanctioned trunk.
 * At a conflicting path the virtual tree is only a diff aid, not proof of inheritance. */
async function comparison(g: Git, build: Sha, trunk: Sha | null) {
	if (!trunk || build === trunk || (await g.ancestor(trunk, build)))
		return { base: build, conflicts: [] };
	if (await g.ancestor(build, trunk)) return { base: trunk, conflicts: [] };
	const r = await g.run(
		"merge-tree",
		"--write-tree",
		"--name-only",
		"--no-messages",
		"-z",
		oid(build),
		oid(trunk),
	);
	if (r.code !== 1) success(r);
	const [tree, ...conflicts] = zlist(r.stdout);
	return {
		base: await g.commit(
			tree!,
			[build, trunk],
			"comparison",
			"Inherited inputs",
		),
		conflicts,
	};
}

/** Keep Git's case-sensitive top-level glob semantics, but don't let a pathspec
 * turn a rename across the protection boundary into an apparent addition. */
async function changed(
	g: Git,
	from: Sha,
	to: Sha,
	globs: readonly string[] | undefined,
) {
	if (from === to) return [];
	const paths = globs ? new Set(await touchedPaths(g, from, to, globs)) : null;
	const raw = zlist(
		await g.output(
			"diff",
			"--raw",
			"--no-abbrev",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames",
			"--ignore-submodules=none",
			"-z",
			oid(from),
			oid(to),
			"--",
		),
	);
	const changes: { change: ProtectedChange; selected: boolean }[] = [];
	for (let i = 0; i < raw.length; ) {
		const [oldMode, newMode, oldId, newId, status] =
			raw[i++]!.slice(1).split(" ");
		const path = raw[i++]!;
		const kind = status?.startsWith("R")
			? "renamed"
			: status === "A"
				? "added"
				: status === "D"
					? "deleted"
					: "modified";
		const dest = kind === "renamed" ? raw[i++]! : path;
		// Include both endpoints so allowing one rename doesn't authorize a different one.
		const before = `${oldMode}:${oldId}${kind === "renamed" ? `:${path}` : ""}`,
			after = `${newMode}:${newId}${kind === "renamed" ? `:${dest}` : ""}`;
		for (const name of dest === path ? [path] : [path, dest]) {
			const selected = !paths || paths.has(name);
			if (selected || isPolicyPath(name))
				changes.push({ change: { path: name, kind, before, after }, selected });
		}
	}
	return changes;
}

/** Publish considers each best build base. At integration the only build base is
 * the exact expected CAS input. A sanction does not prove the worker took it:
 * discount trunk only if its pinned commit is an ancestor of the item itself. */
export async function changeReport(
	g: Git,
	bases: readonly Sha[],
	item: Sha,
	target: Sha,
	trunk: Sha | null,
	globs?: readonly string[],
) {
	const inherited = trunk && (await g.ancestor(trunk, item)) ? trunk : null;
	const changes = new Map<string, ProtectedChange>();
	const touched = new Set<string>();
	const remember = ({
		change,
		selected,
	}: {
		change: ProtectedChange;
		selected: boolean;
	}) => {
		changes.set(JSON.stringify(change), change);
		if (selected) touched.add(change.path);
	};
	let diffBase: Sha | null = null;
	for (const build of bases) {
		const { base, conflicts } = await comparison(g, build, inherited);
		for (const c of await changed(g, base, target, globs)) remember(c);
		if (conflicts.length) {
			const unresolved = new Set(conflicts);
			// Taking either side of a genuine conflict is a resolution, not mere inheritance.
			for (const parent of [build, inherited!])
				for (const c of await changed(g, parent, target, globs))
					if (unresolved.has(c.change.path)) remember(c);
		}
		diffBase =
			diffBase === null ? base : (await comparison(g, diffBase, base)).base;
	}
	const classified = [...changes.values()].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	return {
		base: diffBase!,
		changes: classified,
		touched: [...touched].sort(),
	};
}
