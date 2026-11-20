# Keel development workflow

Start a Keel conversation in a Git project and describe a change. For a bug, performance issue or other change fully determined by an approved reference, the designer binds a small Mandate under the authority of the prompt. There is **no Mandate approval step** on this path. The reference, intent, labelled rules and probes, timed proof commands and protected path globs are the starting record. A request that sets precedent is recorded, not built: design rounds are not implemented yet.

## Roles and tools

| Who | What they do | Keel tools |
| --- | --- | --- |
| Designer (the entry conversation) | Reads the project and classifies the request. Records two readings if they lead to different results. Remains the owner's desk. | `ground`, `request_cancel` (standing) |
| Coordinator (one per work) | Plans goals and dependencies, briefs ready items against named Mandate nodes, and hands the merged build to Verify. It has `read` and does not implement. | `publish_plan`, `brief_item`, `handoff_build` |
| Worker (one checkout per attempt) | Implements the brief inside its fences. Records rulings with their reference and cost if wrong. Publishes a clean committed build and names the block threads it addressed. Keel reads the commit from Git. | `record_ruling` (standing), `publish_build` |
| Verifier | Checks each published commit in a detached checkout, then checks the whole build. Names block threads and their evidence, and keeps lesser findings as notes. | `publish_verdict` |
| Diagnoser | After the same block survives two **claimed** fixes, independently tests the shared premise before the owner is asked. | `publish_diagnosis` |

Designers, verifiers and diagnosers have `read` and `bash`. Workers also have `edit` and `write`. A role's tool list is not a filesystem sandbox. In particular, proof commands are executable project data: the designer must choose trusted, replay-safe commands suitable for a disposable checkout. Keel always includes `.keel/**` among the protected paths so workers cannot silently change the verification playbook. No item, including Encode, may change `.keel` policy. Under other protected globs, any item may add a file. Modifications, deletions and renames require either an Encode item under an owner-reviewed Mandate or the owner's permission for that publication. Keel checks both the publication and the merge candidate, excluding what the worker merely inherited from an authorized trunk correction.

## What the owner decides

- **Ambiguity:** choose the first or second reading, optionally annotating the choice, or decline the work. Keel returns the chosen reading to the designer before a Mandate can bind.
- **At any point in open work:** ask the designer to cancel. Its standing `request_cancel` tool opens a confirmation; only answering `cancel` cancels. `continue` leaves the work alone. Keel does not stop the designer's conversation.
- **Holding finding:** `resume` with direction, or `cancel` the entire piece of work. An owner-waivable protected change also offers `allow`; the verifier is told what changed and whether it was allowed. Resume is not permission to publish the change. Keel files these findings for protected changes, diagnosed non-convergence, moved refs, occupied paths, exhausted effects or a stalled agent. Stopping a running agent in the client goes here too. An item resume resets its survived-fix counts. A chat message is not a decision. Cancellation is recorded before agents are stopped. Keel waits for claimed operations that can still change a checkout and removes what it can prove disposable. One final cleanup note lists what it could not remove. Build and item branch refs survive. A landing already in flight can finish; Keel reports what actually happened.
- **Hand-over:** `accept` closes the work. `reject` with annotations records the missing check. The commit, result against intent, rulings in order of cost if wrong, verifier notes, diagnosed non-convergence, owner direction from findings, and residual risk are in the decision basis. The landing slot has already been released. Rejecting does not revert trunk or prevent other work from landing.

## Git and recovery

Keel starts `keel/<work>/build` from its configured trunk (initializing a missing trunk from the base). A worker builds on `keel/<work>/item/<item>-<attempt>`. Worker, verifier and integration directories live beneath `<git-common-dir>/keel/<work>/`. Passing items merge one at a time against the current build, with the Mandate's proof commands and their timeouts. Conflicts and failed integration proofs go back as integration work, not verdicts. Verifier checkouts are removed on pass or supersession. Cleanup preserves worker data it cannot safely remove.

After full-set verification, one work at a time takes trunk into the build and prepares a landing. If trunk advanced from the verified baseline, a verifier checks the exact prepared commit before Keel updates the ref. A changed result lands as one commit whose only parent is the previous trunk; an unchanged tree needs no empty commit. **Keel never updates the base or promotes trunk to `main`.** Promotion is the owner's decision outside Keel.

The kernel reconciles lane declarations into durable decisions, agent inputs and repository plans. `keel.answer`, `keel.deliver`, `keel.effect` and `keel.stop` run the continuations. Git operations use pinned plans and ownership evidence so a restart can recognize a completed write. See [repository guarantees and limits](src/repo/README.md), including proof replay and worktree retention.

## Project options

Set four lane models in `provider/modelId` form. Each role can independently override its lane. Use a verification model independent of the builder. Model options for later roles already exist; setting them does not activate those roles.

| Required lane model | Active role overrides | Reserved role overrides |
| --- | --- | --- |
| `design` | `designer` | `design_explorer`, `design_prototype`, `arena_seat_1`, `arena_seat_2`, `arena_seat_3`, `arena_judge`, `arena_challenger` |
| `build` | `coordinator`, `worker` | `build_explorer` |
| `verify` | `verifier`, `diagnoser` | |
| `queue` | | `investigator`, `queue_explorer` |

`base` defaults to `main`; `trunk` defaults to `trunk`. Use distinct short branch names outside Keel's namespace. `trunk` cannot be `main`. `max_workers` is a positive integer (default `3`); it bounds concurrent items in a build.

## Not built yet

This slice covers delivery of precedent-following work. Mandate review rounds, riders, principles delivery and mid-build Mandate revision are not implemented. There is no investigator, classification, batching, triage of non-holding findings or general live-plan editing. Dispatch, the design arena, missing-check follow-up and the scheduled sweep are later slices.
