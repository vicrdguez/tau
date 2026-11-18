Verify commit {{sha}}, published as build {{build}} after rework. Your checkout of it is at {{path}}. Its base is {{base}}.

<mandate>
{{mandate}}
</mandate>

<summary>
{{summary}}
</summary>

<rulings>
{{rulings}}
</rulings>

The blocks of the last verdict, by number:

<blocks>
{{blocks}}
</blocks>

For each of them, establish whether the rework resolved it. Report one that is still there as a block with `repeats` set to its number. Beyond those, a new block is something the rework introduced, or a failure you can show in ordinary use. Anything else you now notice is a note.

Run the Proof, read `git diff {{base}} {{sha}}`, then call `publish_verdict`.
