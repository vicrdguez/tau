# Dispatch and arena failure inventory

## Platform

- A killed tool task loses its children, duplicates its first submission, or cannot join the same children on replay.

## Dispatch

- A toy extension cannot configure a roster, or joining children that finish out of order shifts their answers.
- An unanswered child loses the other answers or stalls the join indefinitely.
- Aborting the caller leaves owned children running.
- A child dispatch call gets past the ownership guard.
- An empty, oversized or unknown-seat request starts children.
- A paused or retired agent calls dispatch and creates children.

## Arena

- Candidate options share a family, or the judge shares the designer's family, and children start anyway.
- A candidate omits unasked decisions, or a stage fails, and the arena silently proceeds.
- The owner sees a review before the challenger runs or without all objections disposed.
- The owner takes a named candidate and the designer silently retains the old base.
- Seeded and fresh reruns lose the earlier arena or pass the wrong seed.
- Decline leaves arena work running or opens build.
- An observable experiment without a written decision rule launches a prototype.

## Scenario 2

- Ground does not join two explorers; the review omits a candidate, graft provenance, judge, challenger, or one of three riders; either annotation round is lost; or approval does not ship the three-item dependent build on trunk.
