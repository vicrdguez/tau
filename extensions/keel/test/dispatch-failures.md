# Dispatch and arena failure inventory

The installed-API probe was committed before the dispatcher (`00e32e8`). The same kill seam now drives the extracted module. The test names below describe the protected behavior, including cases grouped into a single test.

## Dispatch and Tau boundary

- A killed toy tool rejoins its original children and reuses each admitted submission.
- A toy roster supplies child tools, model and instructions; reversed completion order cannot reorder answers.
- A provider error is joined as one child's failure; the sibling's answer still returns.
- A non-answer times out and is joined as one child's failure; the sibling still returns.
- Aborting the calling conversation leaves its child idle with no live tasks.
- An owned child cannot use fan-out even through another registered tool.
- An empty job list is refused before creating any children.
- An oversized job list is refused before creating any children.
- An unavailable seat refuses the whole job list before creating any children.
- A paused agent's old Tau tool list does not let it dispatch.
- A retired agent's old Tau tool list does not let it dispatch.
- An effect runner reuses its joined child on retry and cannot advance the task itself.

## Arena and review

- Ground opens framing; unframed work cannot publish a synthesis, and candidate plans share one prompt.
- Same-provider candidates or a judge on the designer's provider refuse all dispatch and name which options to change.
- The optional third candidate joins in order; the judge sees every full candidate and the rubric.
- A timed-out candidate or missing unasked decisions blocks judging; retry keeps the attempt and ignores stale facts.
- Failed effects, mismatched seat results and incomplete judge reports cannot advance the arena.
- Invalid base and graft sources, malformed objections and missing or duplicate replies cannot open review.
- Taking a named candidate pins the new base and opens another review without binding it.
- Seeded and fresh arenas preserve earlier records; only seeded candidates receive the old review.
- Rework keeps the original challenge and first round and requires numbered replies.
- Decline from review or a failed dispatch withdraws all design declarations and does not bind.
- A stopped designer resumes the same turn under a new token without redispatch.
- Cancelling a pending arena withdraws the plan and a late effect cannot start the next stage.
- Declining a completed arena in Tau leaves six settled child conversations, no tasks, no decision and no build.

## Experiments

- A prototype cannot start without a written decision rule.
- A protocol missing the node, observable question, controls or single axis is refused.
- Fewer than two, more than eight, or duplicate variants are refused.
- Each prototype has one pinned variant and receives the same controls and decision rule.
- The designer cannot decide before observations arrive, and foreign or repeated facts cannot settle a run.
- The node retains the protocol, receipts and comparison together.
- Only the winning variant's unasked choices become stable proposed riders.
- A recorded comparison needs a reason and a valid winning variant or an inconclusive outcome.
- A failed child is kept beside its successful sibling and cannot be counted as a win.
- A missing incidental-choice report does not silently allow a winner.
- A failed effect or unmatched batch remains inconclusive evidence without redispatch.
- Real prototypes write separate scratch files and add node-linked comparison and winning rider evidence to review.

## Scenario 2

- Two Ground explorers read the real project; candidates receive identical prompts; judge, grafts, three riders and challenge appear in review; two annotation answers precede approval and the three-item dependent landing.
