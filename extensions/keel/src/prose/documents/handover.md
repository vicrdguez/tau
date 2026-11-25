Accept the result on {{trunk}}, or reject it and annotate what needs to change. Each annotation is filed as a finding for investigation and triage. This decision does not hold the landing slot or change trunk.

{{evidence}}

Promotion to {{base}} is yours. From a clean checkout of {{base}}, run `git merge --ff-only {{sha}}` to promote it.
