# Hand-over and sweep failure inventory

## Hand-over

- A blank or unannotated rejection fails to ask again or files a finding anyway.
- An annotated rejection loses an annotation, owner attribution, the landed commit or the hand-over evidence.
- An investigator closes an owner's finding as no action.
- Real repository: the rejection bypasses investigation, defer does not park a finding, or build does not seed new work.

## Sweep and queue

- An unset interval runs a sweep; idle projects never run one; a tick stops after failure or repeats across restart.
- A sweep interferes with a landing; a project finding holds work or cannot be investigated and built independently.
- A sweep loses drift evidence or gives unreviewed or cancelled design authority.
- A counterexample to a blessed pattern is discarded; filing alone revokes it.

## Principles

- An observed principle violation fails to return work or fails to file separate policy evidence.
- A binding or removal proposal loses the recorded evidence, repeats without new evidence, or updates policy without the owner's answer.
