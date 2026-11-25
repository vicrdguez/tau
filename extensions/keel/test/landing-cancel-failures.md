# Landing and cancellation: review notes 2 and 3

- A recorded landing leaves an earlier cancel confirmation open. A late `cancel` answer can then withdraw the hand-over.
- A new desk request after landing offers cancellation instead of telling the owner to accept or reject the hand-over. An unchanged landing has the same hand-over obligation.
- Cancellation drops a landing with exhausted deliveries even though the compare-and-swap may already have succeeded. It must replay the original operation, under the slot, before finishing cleanup. This applies even if a resume declared the retry but it has not started yet.
- Replay can confirm the landing, find a different trunk head, or exhaust its own retries. Report the observed head or say it is unknown and why; never claim a rollback or silently discard the result.
- A definitive obstruction must not become permission to try a cancelled write. A never-started landing remains withdrawable, and a running landing still finishes under the slot.
