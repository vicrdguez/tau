Accept the result on {{trunk}}, or reject it and annotate the check that was missing. This decision does not hold the landing slot or change trunk.

{{result}}
Trunk commit: {{sha}}
Intent: {{intent}}
What landed: {{summary}}
Verification: {{verdict}}

Rulings, highest cost if wrong first:
{{rulings}}

Verifier notes:
{{notes}}

Non-convergence and diagnosis:
{{diagnoses}}

Direction the owner gave on findings:
{{directions}}

Residual risk: {{risk}}

Promotion to {{base}} is yours. From a clean checkout of {{base}}, run `git merge --ff-only {{sha}}` to promote it.
