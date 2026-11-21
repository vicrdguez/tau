Accept the result on {{trunk}}, or reject it and annotate each check that was missing. Each annotation becomes a check that is owed until built or dropped. This decision does not hold the landing slot or change trunk.

Build starts work to encode a check. Defer keeps it owed and listed. Drop clears it.

Checks still owed

{{owed}}

{{evidence}}

Promotion to {{base}} is yours. From a clean checkout of {{base}}, run `git merge --ff-only {{sha}}` to promote it.
