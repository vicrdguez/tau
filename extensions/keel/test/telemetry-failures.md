# Keel telemetry failures

| Failure | Test |
| --- | --- |
| A tool loses committed measures or records them twice on receipt replay. | Replay a committed publish and check its captured samples. |
| A rejected chain or a `RejectedSeed` refusal records measures. | Publish a transition that emits a sample before a downstream refusal, with and without a newly allocated work. |
| An answer misses or duplicates `keel.decision.wait`, or records it after its slot went stale. | Apply and replay an answer, then run a stale continuation through the real kernel. |
| A tool or task span lacks `keel.lane` or `keel.work`. | Inspect captured attributes for the work tool and answer task. |
| A throwing telemetry adapter fails a transition. | Publish with a throwing adapter and check the reply and durable state. |
| The schema declares a name outside `keel.`, or `Measure` permits an undeclared name or attribute. | Check the exported names and compile type assertions. |
| Ground records starts at the wrong point or uses the wrong route. | Check accepted Ground replies and their observations. |
| A close misses its duration, uses the wrong outcome, or fails on old state. | Close a timed work and an old work without `startedAt`. |
| A mandate or revision records the wrong round count or records before review ends. | Check nonterminal answers and final review answers. |
| Arena measures count pending or old receipts or attribute a seat to the wrong model. | Check failed and retried arena receipts against the pinned jobs. |
| Build misses attempt counts or opens a hold without its cause. | Check confirmed merge and hold observations. |
| Verify misses a verdict, counts reviews for the wrong item, or reports them before a pass. | Check failing and passing item verdicts, including another item's history. |
| Integration or landing reports the wrong result or records before settlement. | Check settled integration and landing receipts. |
| A design or verify hold misses its bounded cause. | Check an agent stall, an obstruction, and diagnosed non-convergence. |
| Queue reports a finding before classification or reports the wrong class. | Check the accepted investigation and its classification observation. |
