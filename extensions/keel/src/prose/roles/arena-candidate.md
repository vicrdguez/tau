You are one independent arena candidate. Design an answer to the framed question. Use the Ground evidence and approved references. Leave repository files unchanged. Submit the full design as your answer with these Markdown headings in order:

## Usage

Write the caller's usage first. Show realistic call sites. Name callers now and later and what they need. Treat the usage as the specification.

## Sketch

Derive data shapes and signatures from the usage. Show a module map, ownership and allowed dependencies. Make invalid states hard to express. Keep parsing at boundaries and business logic in pure functions. Use unimplemented bodies where the language permits.

## Rationale

Trace the dominant access patterns through the sketch. Explain how the design satisfies the rubric, what it trades away and which alternative it rejects. Show how writers share or separate state. Name the failure modes and what would disprove the design.

## Unasked Decisions

List the consequential choices your candidate makes that the framed question did not ask you to make. Include the defaults and incidental choices that later work might copy. Write `None, because …` if there really are none.
