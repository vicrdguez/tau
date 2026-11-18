# Keel development workflow

This first slice delivers one piece of work. The owner approves its shape in a **Mandate**. The worker makes and records the decisions below that boundary. A separate verifier runs the Mandate's Proof before the owner decides whether to take the commit.

| Option | Meaning |
| --- | --- |
| `designer` | Designer model |
| `worker` | Worker model |
| `verifier` | Verifier model |
| `base` | Git base ref, default `main`; its commit is pinned at approval |

Set each model independently in `provider/modelId` form. The designer follows the project default with a tool filter. The worker and verifier have closed tool lists. The verifier gets exactly `read`, `bash`, and `publish_verdict`: its checkout separates working files, not permissions.

| Kind | Name | Purpose |
| --- | --- | --- |
| Tool | `publish_mandate` | Submit the Mandate for the owner's review |
| Tool | `record_ruling` | Record the worker's decision, reason, cost if wrong, and reference; keep working |
| Tool | `publish_build` | Publish a clean branch head with the pending rulings |
| Tool | `publish_verdict` | Pass with optional notes, or fail with at least one block |
| Tasks | `keel.mandate_answer`, `keel.prepare` | Continue after a Mandate answer and prepare the worker's worktree |
| Tasks | `keel.verify_start`, `keel.rework_start` | Prepare the verifier's checkout and route failed checks to the worker |
| Tasks | `keel.handoff`, `keel.retry`, `keel.stop`, `keel.ensure_handoff` | Hand over, retry, stop, or ask for direction after a missing handoff |
| Decision | `keel:<k>:mandate` | Approve, revise, or abort |
| Decision | `keel:<k>:handover` | Approve or abort |
| Decision | `keel:<k>:stuck` | Retry or abort |

1. The designer publishes a Mandate. On revision, the next Mandate must reply to each numbered annotation. On approval, Keel plans the `keel/<k>` branch and worktree; the first build owes replies to the approval's annotations. `<k>` is the designer conversation ID.
2. The worker records rulings and commits its work. Publishing reads the SHA from Git and attaches those rulings to that build only.
3. The verifier runs checks in a detached worktree for that SHA. A later commit gets a different path; the same verifier conversation moves there. If a planned path is unexpectedly occupied, Keel asks the owner rather than resetting or deleting it.
4. A failure returns the verdict text and numbered blocks, not the notes, to the worker. Finding numbers are one-based positions in the verdict, so a filtered list can have gaps. A later verifier uses `repeats` to identify a block that survived rework. There is no round cap. A block that survives two fixes stops automatic rework. The stuck decision quotes it and lists every block of that verdict. Retry then sends the worker the owner's notes with that verdict and its blocks, and resets the counts. Every other retry sends only the owner's notes.
5. A pass opens **Hand over `<sha>`** with the verdict, its notes, and every ruling recorded since the Mandate was approved, in the order recorded. The verifier's input lists only the rulings of the build under review. Approval checks the branch still points to the candidate. Keel gives the owner the fast-forward command; it never merges.

A completed agent run that owes a handoff opens a stuck decision on the agent's last words. Aborting records cancellation before stopping the agents. Worktrees remain available for inspection.

**Not in this slice:** no design arena, multi-item plan, queue, landing on trunk, or dispatch of sub-agents. Principles and playbooks are not wired. Verifier checkouts are never cleaned up.

To try it, install `keel` with the [extension installer](../../docs/extensions.md#install-an-extension), add it to a project bound to a Git repository, set the three models, and create a Keel conversation with the owner's request.
