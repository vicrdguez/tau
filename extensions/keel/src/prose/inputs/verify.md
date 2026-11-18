Verify commit {{sha}}, published as build {{build}}. Your checkout of it is at {{path}}. Its base is {{base}}.

<mandate>
{{mandate}}
</mandate>

<summary>
{{summary}}
</summary>

<rulings>
{{rulings}}
</rulings>

Run the Proof, read `git --no-replace-objects diff {{base}} {{sha}}`, then call `publish_verdict`.
