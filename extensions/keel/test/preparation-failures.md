# Worker preparation and replacement cleanup

- A worker observes the new build head before Build records the merge: no owner finding, stale delivery or worker on the old base; the matching merge re-prepares it.
- If the recorded merge differs, the original observed head and item reach one holding finding instead. A return without merging cannot explain the move either.
- A fresh worker for another item cannot trigger an abandoned checkout's removal. Confirming the replacement removes all earlier attempts of its item, never as merged workers.
- A refused or failed old checkout removal reports its path and evidence, leaves the replacement usable and appears in any later cancellation summary. A successful removal is never planned again.
- Cancel before replacement confirmation collects the abandoned and replacing attempts; cancel during an old attempt's removal drains that same operation once.
