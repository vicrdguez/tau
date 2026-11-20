# Keel development workflow

Start a Keel conversation in a Git project and describe a change. For a bug, performance issue or other change fully determined by an approved reference, the designer binds a small Mandate under the authority of the prompt. There is **no Mandate approval step** on this path. The reference, intent, labelled rules and probes, timed proof commands and protected path globs are the starting record. If no approved reference settles a direction, seam, crossing, domain rule or first of its kind, the designer audits the code and documents against your intent. You settle the proposed Mandate before the build begins.

## Roles and tools

| Who | What they do | Keel tools |
| --- | --- | --- |
| Designer (the entry conversation) | Reads the project and classifies the request. Records two readings if they lead to different results. Remains the owner's desk. | `ground`, `publish_mandate`, `request_cancel` (standing) |
| Coordinator (one per work) | Plans goals and dependencies, briefs ready items against named Mandate nodes, and hands the merged build to Verify. It has `read` and does not implement. | `publish_plan`, `brief_item`, `handoff_build` |
| Worker (one checkout per attempt) | Implements the brief inside its fences. Records rulings with their reference and cost if wrong. Publishes a clean committed build and names the block threads it addressed. Keel reads the commit from Git. | `record_ruling` (standing), `publish_build` |
| Verifier | Checks each published commit in a detached checkout, then checks the whole build. Names block threads and their evidence, and keeps lesser findings as notes. | `publish_verdict` |
| Diagnoser | After the same block survives two **claimed** fixes, independently tests the shared premise before the owner is asked. | `publish_diagnosis` |

Designers, verifiers and diagnosers have `read` and `bash`. Workers also have `edit` and `write`. A role's tool list is not a filesystem sandbox. In particular, proof commands are executable project data: the designer must choose trusted, replay-safe commands suitable for a disposable checkout. Keel always includes `.keel/**` among the protected paths so workers cannot silently change the verification playbook. No item, including Encode, may change `.keel` policy. Under other protected globs, any item may add a file. Modifications, deletions and renames require either an Encode item under an owner-reviewed Mandate or the owner's permission for that publication. Keel checks both the publication and the merge candidate, excluding what the worker merely inherited from an authorized trunk correction.

## Review a Mandate

The designer reports what exists and labels gaps and contradictions without declaring them defects. In the review you see the proposed ruling for each, the done predicate, who calls each seam now and later, caller code before signatures, ownership and allowed dependencies, rules and their falsifying probes, anti-criteria, timed proofs, protected paths, tradeoffs and alternatives. A node whose content is settled by an approved reference is context. The round names the labels that need your authority.

- **Review:** `approve` settles the listed nodes. `rework` sends your numbered annotations back to the designer. Every number needs a reply (acted on, considered or dismissed, with a reason). `decline` ends the work without building and records your annotations as not pursued.
- **Each rider:** decide separately whether to `accept` it as binding, `leave_open` for agents, or `design` it. The last choice sends your direction back to the designer for a proposed node under the same label. The review answer never settles riders.
- **Another round:** changed nodes return to review. Unchanged approved nodes and unchanged disposed riders keep their standing. Pending decisions from the preceding draft are withdrawn; their old answers cannot authorize a different draft. Every revision, review scope, answer and numbered reply remains in the record.
- **Build:** only an approved Mandate with all riders settled can bind. Your approval annotations go to the first plan for a numbered reply. A reviewed Mandate with seams or rules requires Encode first: the scaffold, dependency boundaries and protected rule checks. Every later item depends on Encode. Briefs name their binding nodes; a delegated rider is never a source of authority.

## Principles

All five active roles are offered `principle({name})`. Its index lists names and descriptions, first Keel's and then the project's, in filename order. The index and pulls read the conversation's current checkout. The tool requires an active binding, including for the entry designer after Ground. A ruling's `follows` names its reference; `principles` lists the principles it cites. Merely seeing a description, or someone else's pull, does not authorize a citation. Pulls, input deliveries and citations are recorded per conversation.

Add one Markdown file per principle under `.keel/principles/`. Give it a one-line description and a body. Optional roles or matching paths bind the full body. Use repository-relative paths, one fence per line in the item brief. For example:

```markdown
---
description: Keep rounding at the ledger boundary.
roles: [verifier]
paths:
  - "src/ledger/**"
---

Round only when posting a ledger entry. Compare the sum of the posted entries with the settled balance.
```

Worker bindings use the policy from the item's prepared base; the index and explicit pulls see later edits in that checkout. A verifier receives every project description from the checkout it reviews. Keel binds `model-the-domain` when the designer shapes or revises a Mandate. A failed claimed fix adds `attack-the-premise` to the worker's rework input. A diagnosis gets both `attack-the-premise` and `fix-root-causes`. Project policy stays protected even from Encode.

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

Designers author precedent-setting Mandates directly. Mid-build Mandate revisions and targeted holds are not implemented. There is no investigator, classification, batching, triage of non-holding findings or general live-plan editing. Dispatch, the design arena, missing-check follow-up and the scheduled sweep are later slices.
