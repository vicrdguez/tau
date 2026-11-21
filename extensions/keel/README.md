# Keel development workflow

Start a Keel conversation in a Git project and describe a change. For a bug, performance issue or other change fully determined by an approved reference, the designer binds a small Mandate under the authority of the prompt. There is **no Mandate approval step** on this path. The reference, intent, labelled rules and probes, and timed proof commands are the starting record. If no approved reference settles a direction, seam, crossing, domain rule or first of its kind, the designer audits the code and documents against your intent. Keel runs an arena before asking you to settle the proposed Mandate.

## Roles and tools

| Who | What they do | Keel tools |
| --- | --- | --- |
| Designer (the entry conversation) | Classifies the request, frames the arena, writes the synthesis and proposes live revisions. Records two readings if they lead to different results. Remains the owner's desk. | `dispatch`, `ground`, `frame_arena`, `start_experiment`, `record_experiment`, `publish_mandate`, `answer_challenger`, `publish_revision`, `revision_settled`, `request_cancel` (standing) |
| Coordinator (one per work) | Plans goals and dependencies, briefs ready items against named Mandate nodes, and hands the merged build to Verify. It has `read` and does not implement. | `dispatch`, `publish_plan`, `brief_item`, `handoff_build` |
| Worker (one checkout per attempt) | Implements the brief inside its fences. Records rulings with their reference and cost if wrong. Publishes a clean committed build and names the block threads it addressed. Keel reads the commit from Git. | `dispatch`, `record_ruling` (standing), `publish_build` |
| Verifier | Checks each published commit in a detached checkout, then checks the whole build. Names block threads and their evidence, and keeps lesser findings as notes. | `publish_verdict` |
| Diagnoser | After the same block survives two **claimed** fixes, independently tests the shared premise before the owner is asked. | `publish_diagnosis` |
| Investigator (one per project) | Reproduces or measures, checks the queue and plan for duplicates, and recommends a route. Does not design the fix. | `dispatch`, `report_investigation` |

Bound agents can use the standing `file_finding` tool. Designers, verifiers, diagnosers and the investigator have `read` and `bash`. Workers also have `edit` and `write`. A role's tool list is not a filesystem sandbox. In particular, proof commands are executable project data: the designer must choose trusted, replay-safe commands suitable for a disposable checkout. Item, full-set and landing reviews all show the changed `.keel/principles/` and `.keel/playbooks/` paths reported by Git. These should be unchanged unless an item under review was tasked with creating or changing them. A weakened check is a block.

## Dispatch and the arena

`dispatch` joins up to eight independent questions and returns every answer or failure in job order. The designer can use `design_explorer` during Ground. Coordinators and workers use `build_explorer`, and the investigator uses `queue_explorer`. Explorers trace how behavior works and check why an existing pattern does or does not count as approved. They use Git, the repository's documents, and Keel's records for the work and project. Children cannot dispatch.

The designer frames one question and rubric. Keel gives the same prompt to two candidates, or three if `arena_seat_3` is set. Candidates must use distinct providers, and the judge must use a different provider from the designer. Keel refuses the arena before starting any children if these settings conflict. Set the options named in the decision, then choose `retry`, or choose `decline`. If a child fails or its report is incomplete, `retry` reruns that stage with the same planned inputs and preserves the failure.

The judge scores each candidate and reports its unasked decisions. The designer chooses a base, attributes each graft and turns the winning candidate's unasked choices into proposed riders. A challenger compares the synthesis with the nearest example and the project's principles. The designer must give a numbered disposition for every objection before Keel opens a decision.

When an observable question comes up in framing or synthesis, the designer writes a protocol first: one named node, the question, the decision rule, shared controls and variants along one axis. Keel runs one prototype per variant in separate scratch directories. The designer records the comparison under that node. The winning prototype's incidental choices appear as open riders unless the designer proposes binding them. Failed or incomparable results can be recorded as inconclusive. Scratch directories stay in the system temporary directory for inspection. A scratch directory is a working directory, not a sandbox.

Dispatch lives in `src/dispatch/`. A tool or effect task owns its children and pins the job order, child IDs and timeout. Restart rejoins the stored submissions instead of creating duplicates. Each child is limited to 12 tool rounds and a shared five-minute batch deadline. Timeout asks Tau to abort the affected child; cancellation still depends on the provider and tools responding to Tau's abort signal.

## Review a Mandate

The designer reports what exists and labels gaps and contradictions without declaring them defects. The review shows the proposed rulings, the done predicate, each seam's callers, caller code before signatures, ownership and allowed dependencies, rules and their falsifying probes, anti-criteria, timed proofs, tradeoffs and alternatives. Each rider has a label, an origin and a proposed disposition: bind or leave open to agents.

- **Review:** `approve` approves the Mandate as shown, including rider dispositions and nodes that cite references. You see the synthesis, every candidate in full, the judge's report, graft sources and challenge dispositions. `rework` sends your numbered annotations back to the designer. Later rounds in the same arena carry forward the original challenge and name the round and base it examined. Annotate a rider the same way you annotate a seam or rule. Every annotation needs a reply (acted on, considered or dismissed, with a reason). `decline` ends the work without building and records annotations still owed as not pursued.
- **Choose a direction:** `base:<seat>` makes the named candidate the next synthesis base without approving it. `arena` starts a new arena seeded with the current review and your annotations. `arena_fresh` starts another arena without giving its candidates the earlier review. Earlier candidates, reports and rounds are kept.
- **Another round:** the review opens with the labels that changed, were added, or were removed. Changed entries include their previous content, and removed entries show separately. Answers to older rounds cannot authorize a different draft. Every revision, answer and numbered reply remains in the record.
- **Build:** approval makes the proposed binding riders binding nodes and delegates the open ones. Your approval annotations go to the first plan for a numbered reply, and you see the replies at hand-over. A reviewed Mandate with seams or rules requires Encode first: the scaffold, dependency boundaries and rule checks. Every later item depends on Encode. Briefs cite binding nodes, never delegated riders.

## Findings and triage

Tell the work's designer what you found. The designer can file it on your behalf, but the message by itself does not move work. A verifier note files a finding automatically and does not block the build. Each finding keeps its source revision, report, and cited Mandate labels when available. An unlikely edge case needs its failure mode, likelihood, and complexity cost. It never holds work, regardless of classification. An item worker or verifier that cannot continue can hold only its own item. A hold for triage lasts until the answer, and a `build` answer for a revision keeps the affected items held until disposition. A blocked defect filer stays held until the fix merges, then starts a fresh attempt from the new build head.

| Investigation result | What happens |
| --- | --- |
| Defect under the current Mandate | The coordinator adds discovered work without an owner decision. |
| No action | The investigator closes an observation that holds nothing and changes no shape. The reason appears at hand-over. |
| Determined by an approved reference | `build` adds it to the active plan or seeds new work under the reference. There is no Mandate approval. `defer` or `drop` keeps the record without starting work. |
| Precedent-setting work | `build` seeds Ground and Mandate review. `defer` or `drop` starts nothing. |
| Wrong Mandate | In an active build, classification holds items with briefs that cite affected nodes, except for unlikely edge cases. After handoff it cannot hold landing. `build` opens or joins the work's one live revision; the designer can name a bound node that already settles a cause. `drop` or `defer` releases the finding's holds. |
| Unapproved pattern cited by a ruling | A worker uses `pattern: true` when `follows` names a project pattern. `bless` makes it a project reference. `revoke` seeds work to make the pattern fail structurally and migrate its callers. `defer` keeps the finding for later. |

The investigator groups findings by naming another finding with the same cause and decision. The decision retains its identity; joining evidence is shown in the queue conversation, and the answer covers every member. A later duplicate of a deferred finding reopens the original with both reports. A later ruling citing a revoked pattern goes to rework without another decision.

## Live plan

Items begin as goals and dependencies. The coordinator briefs ready items against the current build head, up to `max_workers`, and each item uses its own checkout. Only a merged dependency makes a dependent item ready. Review can proceed in parallel, but merges into the build branch are serialized.

An unresolved Mandate node hold prevents full-set handoff, even if the affected item already merged. When you approve a mid-build Mandate revision, the coordinator can add, edit, reorder, or drop unstarted items. The revision and plan edits become active in the same commit. Unaffected items keep moving. A verified item is a record; correcting it takes a new item. A held item gets the changed authority and resumes only after its dependencies merge and its last hold clears.

## Principles

Designers, coordinators, workers, verifiers and diagnosers can call `principle({name})` once they have an active binding. While the entry designer is unbound during Ground it sees no principle index. Once bound, the index lists names and descriptions, first Keel's and then the project's, in filename order. A ruling's `follows` names its reference; `principles` lists the principles it cites. Merely seeing a description, or someone else's pull, does not authorize a citation. Pulls, input deliveries and citations are recorded per conversation.

Keep `.keel/principles/` and `.keel/playbooks/` as real directories inside the repository, not symlinks. Add one Markdown file per principle under `.keel/principles/`. Give it a one-line description and a body. Optional roles or matching paths deliver the full body automatically. A fence is a literal repository-relative file or directory path, one per line, without spaces or globs. Use `.` for the whole repository. For example, `src`, `src/ledger` and `./src/ledger/post.ts` all match `src/ledger/**`. Fences do not limit what an agent can pull by name. In principle `paths`, `./src/ledger/**` and `src/ledger/**` mean the same thing. A parent fence does not match a brace pattern spanning directories. Write `src/ledger/**` and `lib/ledger/**` as separate patterns instead of `{src/ledger,lib/ledger}/**`. For example:

```markdown
---
description: Keep rounding at the ledger boundary.
roles: [verifier]
paths:
  - "src/ledger/**"
---

Round only when posting a ledger entry. Compare the sum of the posted entries with the settled balance.
```

The frontmatter accepts a scalar description and inline or block lists of strings. A project name that matches a Keel name appears as `project/<name>`. A malformed project file or an unknown role name produces a diagnostic; its body is not delivered. Other files remain available.

The worker's index, automatic bindings and explicit pulls all use the principles from its item's prepared base. Other bound roles read from their own checkouts. A verifier receives every project description from the checkout it reviews. Keel binds `model-the-domain` when the designer shapes or revises a Mandate. A failed claimed fix adds `attack-the-premise` to the worker's rework input. A diagnosis gets both `attack-the-premise` and `fix-root-causes`.

## What the owner decides

- **Ambiguity:** choose the first or second reading, optionally annotating the choice, or decline the work. Keel returns the chosen reading to the designer before a Mandate can bind.
- **Before landing:** ask the designer to cancel. Its standing `request_cancel` tool opens a confirmation; only answering `cancel` cancels. `continue` leaves the work alone. Keel does not stop the designer's conversation. After landing, accept or reject the hand-over instead.
- **Holding finding:** `resume` with direction, or `cancel` the entire piece of work. Keel files these findings for diagnosed non-convergence, moved refs, occupied paths, exhausted effects or a stalled agent. Stopping a running agent in the client goes here too. An item resume resets its survived-fix counts. A chat message is not a decision. Cancellation is recorded before agents are stopped. Keel waits for claimed operations that can still change a checkout and removes what it can prove disposable. One final cleanup note lists what it could not remove. Build and item branch refs survive. A landing already in flight can finish; Keel reports what actually happened.
- **Hand-over:** `accept` closes the work. `reject` with annotations files the missing check and landed commit in the queue. The commit, result against intent, rulings in order of cost if wrong, verifier notes, diagnosed non-convergence, your ambiguity readings and annotations, direction on findings, the coordinator's replies to every approval note, Mandate revisions, work findings and their dispositions at landing, and residual risk are in the decision basis. The landing slot has already been released. Rejecting does not revert trunk or prevent other work from landing.

## Git and recovery

Keel starts `keel/<work>/build` from its configured trunk (initializing a missing trunk from the base). A worker builds on `keel/<work>/item/<item>-<attempt>`. Worker, verifier and integration directories live beneath `<git-common-dir>/keel/<work>/`. Passing items merge one at a time against the current build, with the Mandate's proof commands and their timeouts. Conflicts and failed integration proofs go back as integration work, not verdicts. Verifier checkouts are removed on pass or supersession. Cleanup preserves worker data it cannot safely remove.

After full-set verification, one work at a time takes trunk into the build and prepares a landing. If trunk advanced from the verified baseline, a verifier checks the exact prepared commit before Keel updates the ref. A changed result lands as one commit whose only parent is the previous trunk; an unchanged tree needs no empty commit. **Keel never updates the base or promotes trunk to `main`.** Promotion is the owner's decision outside Keel.

The kernel reconciles lane declarations into durable decisions, agent inputs and repository plans. `keel.answer`, `keel.deliver`, `keel.effect` and `keel.stop` run the continuations. Git operations use pinned plans and ownership evidence so a restart can recognize a completed write. See [repository guarantees and limits](src/repo/README.md), including proof replay and worktree retention.

## Project options

Set four lane models in `provider/modelId` form. Each role and seat can independently override its lane. Use a verification model independent of the builder. `arena_seat_3` both selects the third candidate's model and enables its seat.

| Required lane model | Optional role and seat overrides |
| --- | --- |
| `design` | `designer`, `design_explorer`, `design_prototype`, `arena_seat_1`, `arena_seat_2`, `arena_seat_3`, `arena_judge`, `arena_challenger` |
| `build` | `coordinator`, `worker`, `build_explorer` |
| `verify` | `verifier`, `diagnoser` |
| `queue` | `investigator`, `queue_explorer` |

`base` defaults to `main`; `trunk` defaults to `trunk`. Use distinct short branch names outside Keel's namespace. `trunk` cannot be `main`. `max_workers` is a positive integer (default `3`); it bounds concurrent items in a build.

## Not built yet

Turning a missing check into an owed check and running the scheduled drift sweep are later slices.
