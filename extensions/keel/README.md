# Keel development workflow

Keel currently ships its workflow kernel, **not a runnable development lane**. Creating a Keel conversation starts a designer with Tau’s `read` and `bash` tools. There is no tool yet to publish a Mandate, start a build, or land a commit. Keel does not modify Git branches. Standing role instructions come from `src/prose/roles/`; the workflow tools mentioned there are not installed yet.

## Project options

Set a model in `provider/modelId` form for each of the four lanes. Every role, including each arena seat, can override its lane’s model independently. Setting `worker`, for example, changes the worker without changing the coordinator or build explorer.

| Required lane option | Optional role overrides |
| --- | --- |
| `design` | `designer`, `design_explorer`, `design_prototype`, `arena_seat_1`, `arena_seat_2`, `arena_seat_3`, `arena_judge`, `arena_challenger` |
| `build` | `coordinator`, `worker`, `build_explorer` |
| `verify` | `verifier`, `diagnoser` |
| `queue` | `investigator`, `queue_explorer` |

`base` (default `main`) and `trunk` (default `trunk`) must name different branches. `max_workers` (default `3`) is a positive integer. These options are reserved for the repository and build lanes; setting them does not start work.

## What the kernel does

Lanes declare which decisions, agents, inputs and effects should exist. The kernel reconciles those declarations with durable state. It registers four continuation tasks: `keel.answer` consumes a decision answer, `keel.deliver` sends an expected input, `keel.effect` runs a planned effect, and `keel.stop` stops an agent after its pause or cancellation is recorded. A role sees only its coding tools and the registered Keel tools that name it. A closed tool list is not a filesystem sandbox: `bash` runs in the conversation’s environment.

The tests exercise this contract with a toy lane that is **not** part of the installed workflow. The packaged extension currently registers no Keel tools. Repository operations, production lanes, principles and dispatch come in later slices.
