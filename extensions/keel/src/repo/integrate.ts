import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildWork,
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
	ProofChanges,
	RepoInfo,
	RepoResult,
} from "./types.ts";
import {
	advance,
	dirt,
	freeBranch,
	integrationCheckout,
	ownedBranch,
	touchedPaths,
	zlist,
} from "./worktrees.ts";

/** Immutable check receipts live with this effect's private, locked worktree.
 * Checkpoints avoid repeating completed checks on a CAS retry. A crash *inside*
 * a command or before its receipt is durable requires replay: checks cannot be
 * non-idempotent transactions against external systems. */
async function check(
	admin: string,
	candidate: string,
	index: number,
	spec: Check,
	prepare: () => Promise<Git>,
	verifyCheckout: () => Promise<ProofChanges | undefined>,
): Promise<{ report: CheckReport; changes: ProofChanges | undefined }> {
	const { id, argv, timeoutMs } = spec;
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
			typeof receipt.tail !== "string" ||
			(receipt.changes !== undefined &&
				(typeof receipt.changes?.headChanged !== "boolean" ||
					!Array.isArray(receipt.changes.paths) ||
					!receipt.changes.paths.every((p: unknown) => typeof p === "string")))
		)
			throw Error("invalid check receipt");
		return {
			report: { id, code: receipt.code, tail: receipt.tail },
			changes: receipt.changes,
		};
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
	const g = await prepare();
	const r = await g.exec(argv, g.cwd, { env: { ...process.env }, timeoutMs });
	const result = { id, code: r.code, tail: (r.stdout + r.stderr).slice(-4096) };
	const changes = await verifyCheckout();
	const tmp = file + "-" + randomUUID();
	await writeFile(tmp, JSON.stringify({ version: 1, ...result, changes }), {
		flag: "wx",
	});
	try {
		await link(tmp, file);
	} finally {
		await unlink(tmp);
	}
	return { report: result, changes };
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
	if (taking && at === op.expected) {
		const trunk = await g.head(repo.trunk);
		if (trunk !== other) moved(trunk);
		if (await g.ancestor(other, op.expected)) {
			return {
				kind: "combined",
				sha: at,
				trunk,
				checks: [],
				...(op.protectedGlobs ? { touched: [] } : {}),
			};
		}
	}

	if (at === op.expected) await freeBranch(g, into, op.integration);
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
	const paths = op.protectedGlobs
		? {
				touched: await touchedPaths(
					g,
					op.expected,
					candidate,
					op.protectedGlobs,
				),
			}
		: {};
	const target = {
		kind: "checkout",
		key: op.key,
		path: op.integration,
		sha: candidate,
	} as const;
	// Never recreate missing proof evidence on the strength of a branch update.
	const published = at === candidate;
	const { admin, owned } = await integrationCheckout(
		g,
		repo,
		target,
		!published,
	);
	if (!owned && published) occupied(target.path);
	async function changesIn(
		still: NonNullable<typeof owned>,
	): Promise<ProofChanges | undefined> {
		const headChanged = !still.detached || still.head !== candidate;
		const paths = await dirt(still.wt, "proof");
		if (still.head !== candidate) {
			paths.push(
				...zlist(
					await still.wt.output(
						"diff",
						"--name-only",
						"--no-renames",
						"--no-ext-diff",
						"--no-textconv",
						"--ignore-submodules=none",
						"-z",
						candidate,
						still.head ?? "--cached",
						"--",
					),
				),
			);
		}
		return headChanged || paths.length
			? { paths: [...new Set(paths)].sort(), headChanged }
			: undefined;
	}
	let before = owned ? await changesIn(owned) : undefined;
	const prepare = async () => {
		if (!owned || published) occupied(target.path);
		if (!before) return owned.wt;
		// Forget skip-worktree/assume-unchanged bits as well as staged dirt.
		// Checkout detached: reset --hard would move a proof-attached branch.
		await owned.wt.output(
			"rm",
			"-rf",
			"--sparse",
			"--ignore-unmatch",
			"--",
			".",
		);
		await owned.wt.output("checkout", "--force", "--detach", candidate);
		before = undefined;
		return owned.wt;
	};
	const verifyCheckout = async () => {
		const still = await integrationCheckout(g, repo, target, false);
		if (still.admin !== admin) occupied(target.path);
		// A broken checkout no longer resolves a HEAD; do not run Git there.
		return still.owned
			? changesIn(still.owned)
			: { paths: [".git"], headChanged: true };
	};
	const reports: CheckReport[] = [];
	const failed = (changes?: ProofChanges) => ({
		kind: "checks_failed" as const,
		sha: candidate,
		checks: reports,
		...paths,
		...(changes ? { changes } : {}),
	});
	for (const [index, spec] of op.checks.entries()) {
		const r = await check(
			admin,
			candidate,
			index,
			spec,
			prepare,
			verifyCheckout,
		);
		reports.push(r.report);
		if (r.changes || r.report.code !== 0) return failed(r.changes);
	}
	if (!owned) occupied(target.path);
	if (!published && before) return failed(before);
	if (!published) await advance(g, into, op.expected, candidate, op.key);
	return taking
		? {
				...paths,
				kind: "combined",
				sha: candidate,
				trunk: other,
				checks: reports,
			}
		: { ...paths, kind: "merged", sha: candidate, checks: reports };
}

export async function landingCommit(g: Git, plan: Landing) {
	if (!(await g.ancestor(plan.expectedTrunk, plan.combined)))
		throw new TypeError("combined build does not include expected trunk");
	const tree = await g.output("rev-parse", `${oid(plan.combined)}^{tree}`);
	const trunkTree = await g.output(
		"rev-parse",
		`${oid(plan.expectedTrunk)}^{tree}`,
	);
	if (tree === trunkTree) return plan.expectedTrunk;
	return g.commit(tree, [plan.expectedTrunk], plan.key, plan.message);
}
