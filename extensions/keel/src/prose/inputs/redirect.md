The verdict on commit {{sha}} is fail, and one of its blocks has now survived two fixes. Keel stopped and asked the owner, who answered in decision {{decision}}.

<notes>
{{notes}}
</notes>

<verdict>
{{verdict}}
</verdict>

<blocks>
{{blocks}}
</blocks>

Follow the owner's direction. For the block that survived, write down what the last two fixes both assumed and test that assumption before you change code again. Then fix every block at its cause, commit, and call `publish_build` again.
