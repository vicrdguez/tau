# Queue and landing slot: failure inventory

- A repeated filing asks once with the evidence; the same cause in another work or lane is independent.
- Resuming an item sends the finding, cause and annotated direction to its filer and resets only that item's survived-fix counts. Another cause on the item stays open.
- Resuming a work-level stop does not reset any item's counts.
- Cancelling a stopped work withdraws all of its remaining findings and notifies its three lanes, without touching other work. An answer to a withdrawn question cannot resume anything.
- Two works never land together. Repeated requests do not give a second grant or change FIFO order; repeated releases do not unlock the next holder.
- A waiting work can give up its place. An active work's cancellation does not grant the next landing before Verify reports completion and releases the slot.

These tests use lane reductions and declarations. The kernel suite separately exercises consuming decision continuations once, withdrawing decisions and stopping agents only after durable state changes. Build and Verify exercise the stops, resumes and completion of an in-flight landing in their own lanes.
