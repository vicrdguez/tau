# Verify, Queue and the live plan: failure inventory

- A verdict loses a note, takes a hold, files it against the wrong SHA/item, or strips it from the hand-over. An invalid verdict files nothing. A rejected hand-over loses its missing checks or files without its landed evidence; acceptance, a stale answer and rejection without an annotation file nothing.
- A blocking verifier or classified node hold stops a sibling, admits a verdict or stale stall, or releases the verifier before the last cause is gone. Resumption must deliver a fresh token.
- A paused checkout or unclaimed merge starts anyway; a paused merge prevents an unaffected sibling from merging. A merge already claimed may complete and its result must still be recorded.
- A revision lets a paused publication merge using stale evidence instead of returning it to its worker with changed nodes. An in-flight checkout must finish before removal. A merged record is never reworked.
- A newly reviewed Encode keeps a stale protected-candidate decision, reuses a key with changed evidence/proofs or merges the candidate as if it were the original publication. A policy path is never exempt. An outstanding integration result cannot open an obsolete protected hold after the revision.
- A queued merge uses the old proof, globs or Encode authority after the revision; a claimed merge is not mutated. Removing an obsolete checkout/integration must still name its original ownership key.
- Scripted scenarios 1/4: verifier notes appear in actual investigator input and an independent triage decision with their evidence. Answering the note does not replace the hand-over; all original verdict, publication, landing, digest and restart assertions still hold.
