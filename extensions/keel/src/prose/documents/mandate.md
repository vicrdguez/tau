## Intent

Give the owner's goal and a falsifiable done predicate. Keel supplies the reserved label `intent`. Rule labels and check IDs share one label namespace.

## Rules

Give each rule a distinct label. Pair it with the probe that would show it false.

## Proof

Give each proof a distinct label in `id`, its command as an argument vector, and its positive timeout in milliseconds. Choose commands that can safely run again in a disposable checkout.
