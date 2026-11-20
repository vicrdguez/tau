# One-item acceptance failures

- A precedent-following bug stalls for approval, sends a brief to the wrong worker, loses the ruling or failed-verdict thread, skips merge proof or full-set review, lands more than one commit, leaves verifier checkouts, changes main, or fails to close after accept.
- SIGKILL after durable publication but before the first verifier checkout loses or replays the publication; SIGKILL after trunk CAS but before its receipt starts a second review or landing, loses the hand-over, or changes main.

Run both through the real workflow entry and agent tools in a temporary repository. Only the recovery scenario needs SQLite and child processes. All other lane failures belong at the cheaper lane or kernel seam.
