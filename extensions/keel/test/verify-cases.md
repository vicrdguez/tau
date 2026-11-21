# Verify: failure inventory and scripted calls

- Publish opens a detached checkout at the observed SHA. The item verifier receives the repository's comparison base, not the current build tip, along with its brief, rulings, proof, checkout playbook and changed principle or playbook files.
- A pass with a block, a fail without one, duplicate thread IDs or empty grounds/evidence cannot become a verdict.
- The same thread surviving two claimed fixes gets a fresh diagnosis before an owner finding; resume sends the diagnosis and direction, then counts start over.
- Unaddressed reappearances do not count. Distinct blocks across repeated reviews never exhaust a round allowance.
- A pass or superseding publish cleans up the previous checkout with its original ownership key; never remove the worker's tree.
- Simultaneous item passes merge one at a time against the latest build tip, using only Mandate proof commands.
- Merge conflict and failed proof send integration evidence, not a verdict, and clean up the integration checkout. A new correction commit gets a fresh review. A return after taking trunk sends the exact trunk commit that failed to integrate.
- A full-set failure or prepared-commit failure releases any slot and returns the affected work rather than landing it.
- Full-set pass queues for the project slot before taking trunk. Take-trunk conflict or failed proof returns integration work and releases the slot.
- Changed trunk requires a pass on the exact prepared landing SHA. Unchanged trunk uses the full-set pass. No-change preparation does not perform a CAS.
- A moved ref, occupied path or effect exhausted after retries holds the affected operation and reports evidence. Resume must not overwrite a foreign ref or accept an unverified target.
- Stopped, failed and unfulfilled agents hold once; only a resume reopens their obligation with a new token and one-turn owner direction. A later stop or completed tool call does not carry those instructions into the next delivery.
- Cancellation withdraws unclaimed operations and releases a wait/slot. A CAS already running finishes under the slot and its real outcome is reported. Running checkout/integration jobs settle before disposal; held operations are cleaned up without a successor write. Failed removals name their paths in Verify's single cleanup report to Design.
- Hand-over releases the slot before the owner answers. It names the trunk SHA, intent, notes, cost-ordered rulings, residual risk, the directions given across lanes and the diagnosis of non-convergence, even after the original review is superseded. Reject keeps the missing-check annotations; accept and reject close work.
- A superseded answer or effect result cannot reopen work.
- The independently pinned v1 state retains open holds and in-flight landing identifiers.

## Scripted tool contract

`publish_verdict({outcome:"pass"|"fail", text:string, blocks:{thread:string, ground:"failing_run"|"mandate_violation"|"weakened_check"|"false_claim"|"unprobed_rule"|"reachable_harm", evidence:string}[], notes:string[]})`. Pass with `blocks:[]`. Use a stable thread name such as `wrong-total`. Full-set text describes the pass against intent. No hash, item or scope arguments.

`publish_diagnosis({premise:string,test:string,result:string})`.

Full-set rework or integration uses `item:"full"` to request a new correction. Its `head` reflects any completed take-trunk on the build branch. Retrying an in-doubt repo operation assigns a new kernel delivery key and preserves its repo op/key.
