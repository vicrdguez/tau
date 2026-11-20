## Intent

Give the owner's goal and a falsifiable done predicate. Use the label `intent` for this node.

## Rules

Give each rule a distinct label. Pair it with the probe that would show it false.

## Proof

Give each proof a distinct label in `id`, its command as an argument vector, and its positive timeout in milliseconds. Choose commands that can safely run again in a disposable checkout. List protected paths as top-level Git globs under the label `protectedPaths`. Keel also protects `.keel/**`, where the project's verification policy lives.
