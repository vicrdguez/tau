# Build: live-plan failure inventory

Exercise the Build reducer, public view, agent inputs and effect/message declarations. The scripted repository scenarios cover the surrounding lanes.

- An investigator cannot compare a finding with the plan, or mistakes an unstarted item's goal for a rendered brief.
- A blocking filer pauses a sibling, repeated classification loses the original filer hold, or dropping one cause releases another.
- A brief first naming a classified node after restart starts a worker; its unused slot starves unrelated work.
- A preparation finishing while paused loses its fact, or releasing a worker exceeds the worker limit.
- A hold on a publication fails to reach Verify, is sent twice, or is released under the wrong cause.
- A discovered defect is lost, overwrites existing work, or starts implementation without a coordinator plan. An additional finding arriving during planning is lost.
- A discovered finding addressed to a non-mutable Build disappears instead of seeding follow-on work with its reference.
- A draft revision becomes operative before the plan validates, edits a started item, drops a record, accepts a cyclic dependency, or loses an approval annotation.
- An approved revision rewrites a verified item, including one awaiting merge, or omits its correction as new work.
- A pivot cannot edit, reorder or drop unstarted items, or a held worker loses its attempt or resumes before its new dependencies merge.
- A revision unlocks a publication with outstanding dependencies, or loses the review-policy reevaluation of an Encode publication held at Build.
- A hold on an already merged node permits handoff before its disposition.
- A filer resumes or its finding closes after only part of the fix plan has merged.
- A filer linked to a non-blocking defect after planning resumes before the same plan merges.
- Two held filers' fixes depend directly or indirectly on either filer, including via an already planned item.
- A revised plan depends on a defect-held filer or drops an outstanding item planned for that defect.
- An approved revision drops a node still cited by a started item and silently strips the brief's authority.
- Approval notes from separate decisions lose their source or borrow another decision's reply number.
