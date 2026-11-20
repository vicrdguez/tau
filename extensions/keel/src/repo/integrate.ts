import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildWork,
	environment,
	type Git,
	hasCode,
	hash,
	layout,
	moved,
	occupied,
	oid,
	success,
} from "./git.ts";
import type {
	Check,
	CheckReport,
	Integrate,
	Landing,
	RepoInfo,
	RepoResult,
} from "./types.ts";
import {
	advance,
	dirt,
	freeBranch,
	inspect,
	materialize,
	ownedBranch,
	zlist,
} from "./worktrees.ts";

/** Immutable check receipts live with this effect's private, locked worktree.
 * Checkpoints avoid repeating completed checks on a CAS retry. A crash *inside*
 * a command or before its receipt is durable requires replay: checks cannot be
 * non-idempotent transactions against external systems. */
async function check(
	g: Git,
	admin: string,
	candidate: string,
	index: number,
	spec: Check,
	published: boolean,
	verifyCheckout: () => Promise<void>,
): Promise<CheckReport> {
	const { id, argv } = spec,
		timeoutMs = spec.timeoutMs ?? 120_000;
	if (
		!argv[0] ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 2_147_483_647
	)
		throw new TypeError("invalid Mandate check");
	const file = join(
		admin,
		"keel-check-" +
			hash(JSON.stringify([candidate, index, id, argv, timeoutMs])),
	);
	try {
		const receipt = JSON.parse(await readFile(file, "utf8"));
		if (
			receipt.version !== 1 ||
			receipt.id !== id ||
			!Number.isInteger(receipt.code) ||
			typeof receipt.tail !== "string"
		)
			throw Error("invalid check receipt");
		return { id, code: receipt.code, tail: receipt.tail };
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
		if (published) occupied(g.cwd);
	}
	const r = await g.exec(argv, g.cwd, { env: environment(), timeoutMs });
	const result = { id, code: r.code, tail: (r.stdout + r.stderr).slice(-4096) };
	await verifyCheckout();
	const tmp = file + "-" + randomUUID();
	await writeFile(tmp, JSON.stringify({ version: 1, ...result }), {
		flag: "wx",
	});
	try {
		await link(tmp, file);
	} finally {
		await unlink(tmp);
	}
	return result;
}

export async function integrate(
	g: Git,
	repo: RepoInfo,
	op: Integrate,
): Promise<RepoResult> {
	const taking = op.kind === "take_trunk";
	const into = taking ? op.build : op.into,
		other = taking ? op.trunk : op.item;
	const work = buildWork(into);
	if (op.integration !== layout.integration(repo, work, op.key))
		throw new TypeError("invalid integration path");
	const at = await g.head(into);
	if (at === null) moved(null);
	await ownedBranch(g, into);
	if (taking) {
		const trunk = await g.head(repo.trunk);
		if (trunk !== other) moved(trunk);
		if (await g.ancestor(other, op.expected)) {
			if (at !== op.expected) moved(at);
			return { kind: "combined", sha: at, trunk, checks: [] };
		}
	}

	if (at === op.expected) await freeBranch(g, into);
	// Construct the candidate without ever attaching to the build branch,
	// or leaving a half-applied merge in an index. Conflict is ordinary data.
	const merge = await g.run(
		"merge-tree",
		"--write-tree",
		"--name-only",
		"--no-messages",
		"-z",
		oid(op.expected),
		oid(other),
	);
	if (merge.code === 1) {
		if (at !== op.expected) moved(at);
		return {
			kind: "conflict",
			paths: zlist(merge.stdout).slice(1),
			against: other,
		};
	}
	const tree = zlist(success(merge))[0]!;
	const candidate = await g.commit(
		tree,
		[op.expected, other],
		op.key,
		taking ? "Take trunk" : op.message,
	);
	if (at !== op.expected && at !== candidate) moved(at);
	const target = {
		kind: "checkout",
		key: op.key,
		path: op.integration,
		sha: candidate,
	} as const;
	// Never recreate missing proof evidence on the strength of a branch update.
	const published = at === candidate;
	const owned = await materialize(g, repo, target, !published);
	const verifyCheckout = async () => {
		const still = await inspect(g, repo, target);
		if (!still || (await dirt(still.wt)).length) occupied(op.integration);
	};
	const reports: CheckReport[] = [];
	for (const [index, spec] of op.checks.entries()) {
		const r = await check(
			owned.wt,
			owned.admin,
			candidate,
			index,
			spec,
			published,
			verifyCheckout,
		);
		reports.push(r);
		if (r.code !== 0)
			return { kind: "checks_failed", sha: candidate, checks: reports };
	}
	if (!published) await advance(g, into, op.expected, candidate, op.key);
	return taking
		? { kind: "combined", sha: candidate, trunk: other, checks: reports }
		: { kind: "merged", sha: candidate, checks: reports };
}

export async function landingCommit(g: Git, plan: Landing) {
	if (!(await g.ancestor(plan.expectedTrunk, plan.combined)))
		throw new TypeError("combined build does not include expected trunk");
	return g.commit(
		await g.output("rev-parse", oid(plan.combined) + "^{tree}"),
		[plan.expectedTrunk],
		plan.key,
		plan.message,
	);
}
