# Keel repository effects

Import from `index.ts`. Persist the discovery snapshot, immutable `RepoOp` and its unique key **before** passing them to `converge(exec, repo, op)`. Retry that plan, not a refreshed snapshot. Use a new key for a new attempt. Expected obstructions, conflicts and proof failures are results; Git and I/O errors are not evidence of success.

## Start and publish

- `readRepo` discovers the shared layout and reads base and trunk. Use short branch names, not `HEAD` or qualified refs. Trunk cannot be `main`, the base, or in keel's namespace. A missing trunk differs from a trunk pinned to a commit. Discover again for new work.
- Use `layout` for branch names and checkout paths. `start_build` and `worktree` create refs with an absent-old-value CAS. Replay recognizes the completed target before comparing the source tip: the pinned creation SHA and name/key-bound creation reflog entry for a branch, plus the locked registration and reciprocal gitdir links for a worktree. An incomplete creation still checks its source. Publishing a worker or advancing a build requires the branch's own creation entry; a replacement at the same hash or another branch's copied log is insufficient. A branch checked out elsewhere (including one reserved by rebase or bisect) isn't available for CAS.
- Give `readPublishable` the planned worker, not a supplied hash. The worker must be clean and descend from its pinned base. Its `touched` paths are the diff **from the merge base of the current build tip and worker HEAD to worker HEAD**. Merging the build into a worker does not charge it for the build's paths; deleting an inherited path is reported. Renames include both ends. Omit globs for all paths; an empty list selects none. Globs use Git's top-level, case-sensitive pathspec matching; keel doesn't fold case to match the filesystem.

## Integration and proofs

`merge_item` and `take_trunk` construct the candidate before advancing the build. Pin the trunk to take. A conflict returns paths and the opposing commit; it creates no integration checkout. A successful merge/combination returns the commit and check reports. A completed take recognizes its own candidate and receipts even if trunk has since moved.

The **designer writes the proof commands**. Keel runs them as Mandate data, never as tool arguments supplied at merge time. Each `Check` has an `id`, `argv` and a positive integer `timeoutMs`. Commands run against the exact candidate in a disposable, detached integration checkout. Untracked outputs are ignored. A tracked edit (including a staged change), a different commit, or attachment to a branch fails proof. `checks_failed.sha` is always the **candidate**, never the command's resulting HEAD. `checks` preserves command exit codes and output tails; `changes`, when present, names the paths and whether HEAD changed. A same-tree commit can change HEAD with no paths. A failed proof does not advance the build.

Keep the checkout until the result is durable: immutable per-command receipts prevent rerunning an acknowledged command on a CAS retry. Checks must be replay-safe; a runner lost between the command and its receipt cannot guarantee exactly-once external effects. The POSIX `nodeExec` bounds captured output and kills remaining members of a proof's process group on timeout or when the command exits, pass or fail. A proof can outlive a **killed runner** and overlap its retry. Keel never signals a PID recalled from disk: it might have been reused. A custom `Exec` must provide the same process handling and replace, not overlay, the Git environment.

## Cleanup

- `checkout` creates a detached verifier. After a pass or supersession, plan `remove` with its original target. Removal requires the registration in this repository, its disposable-checkout lock/key and both gitdir links, not the verifier's current commit or detachment. It may discard edits and unreferenced verifier commits; it never deletes a branch.
- After **any** integration result, plan `remove` with `target: { kind: "checkout", key: integrationOp.key, path: integrationOp.integration }`. No SHA is required. An absent path with no registration is already removed. A missing directory with a surviving registration, a mismatched lock or a broken link is `occupied`. Disposable locks are distinct from worker locks: a mistaken checkout target cannot discard a worker. Older verifier/integration locks that do not distinguish these roles are refused, not guessed at.
- Plan worker `remove` with its original `worktree` target. Without `merged: true`, even ignored files keep it. **Only once the caller knows the branch was merged**, set `merged: true` on `remove` to discard ignored outputs. Tracked edits, untracked nonignored files, assume-unchanged/skip-worktree entries and gitlinks still return `kept` with `files`. The outer index cannot certify submodule contents. The worker branch survives removal; per-worktree reflogs and private refs do not.

## Landing

Hold the landing slot. Persist `{ kind: "prepare_landing", key: prepareKey, landing }`, where `landing` pins its own future CAS key, expected trunk, combined commit and message. `prepared.sha` is the exact unreferenced target; persist it. If the tree already equals expected trunk's tree and trunk is still there, `unchanged` ends the landing **without a commit or ref update**. A stale no-change plan reports `moved` instead.

When trunk moved since the full-set pass, have the verifier check **the prepared SHA**, not the unsquashed combined commit, while holding the slot. `converge` then runs `{ ...landing, kind: "land", target }`. Keel is the sole writer of trunk: at old, try one CAS to new; at new, report success without writing; anywhere else, report `moved`. There is no witness ref. Cancellation does not interrupt or undo an in-flight landing.

Commits use a fixed keel identity and the first parent's timestamp in UTC. A landing's only parent is the stored trunk; its tree is the combined commit's tree. A pruned prepared target can be recreated with the same ID while its inputs exist. Ordinary Git object retention still applies.

## Limits

Serialize effects per build and landings under the landing slot. Keep repository administrative files and configuration trusted. Ownership checks defend against ordinary foreign checkouts, changed refs and replaced directories, not a malicious process with write access to Git administration. Ref CAS is atomic; inspecting and removing a worktree is not one OS transaction. The crash tests cover either side of completed Git commands, not interruptions inside Git's filesystem operations. Where registration, backlink or ownership evidence is missing, keel refuses rather than repairing by guesswork.

Creation evidence expires with the reflog, so a long-idle build may be refused. Keel isolates Git from global configuration, including global excludes, filters and `safe.directory`; files ignored only by the owner's global config count as dirt at publish.
