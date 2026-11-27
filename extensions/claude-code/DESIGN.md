# Use Claude Code as a Tau model provider

Tau owns messages, tools, retries and compaction. Claude Code supplies inference with the server user's subscription. A workflow changes only the provider prefix.

## Ownership

| Module | Decision |
| --- | --- |
| `provider.ts` | Read the live Anthropic catalog at listing time. Drop dated aliases, cap the window at 200,000 and report zero cost. Translate reasoning to CLI effort. |
| `transcript.ts` | Compile the current system prompt, tool declarations, history and prompt without I/O. Move a turn's results before its steers. Use the same ID table on both sides of every result. |
| `turn.ts` | Reduce partial SDK messages. Publish prose as it arrives. Hold the rest of the message from its first tool block until the entire batch passes validation. |
| `run.ts` | Own the account gate, MCP server, child lifetime, deadline, and turn publication. |
| `session.ts` | Claim a conversation, prepare its file, and record the published turn after the child exits. |

Each request runs a new Claude Code child. Only the session file and its record carry context between requests. Tau's transcript remains authoritative.

## Protocol decisions

The continuation probe on CLI 2.1.311 found that a streamed tool result did not work as the prompt. Importing the result and sending a fixed continuation message did. The compiler instead sends the real trailing user message when one is present. Signed thinking is portable only within this provider.

The schema on MCP's tools list is Tau's own JSON Schema. A Zod conversion would change nested schemas. A root combinator can cause Claude Code to omit a tool, so compilation rejects it. The MCP handler waits for shutdown. It never executes the tool.

In probe Q6, initialization and account information arrived before the input iterator yielded. A separate CLI init frame arrived after the prompt. The provider checks the account before releasing the iterator. It gives the child an environment allowlist at the actual spawn boundary. It passes an explicit system prompt, disables settings sources and builtin tools, and disables Claude Code compaction.

Claude Code reports its runtime directory as the primary working directory. Tau runs tools in the conversation's working directory. The provider appends an instruction to use project-relative paths. In one live trial per prompt, Sonnet 4.6 used the absolute runtime path without the instruction and a relative path with it. A full fix requires the provider to receive the conversation's working directory. `pi-durable` does not pass that directory today.

In Q7 the first MCP call arrived after the first tool block stopped but before the second tool block stopped. Handler entry cannot authorize a batch. The provider waits for `message_stop` with `tool_use`, verifies each offered name, ID, completed block and JSON object, then interrupts the query. It drains the interruption result before closing. A normal text answer requires both a completed message and a successful SDK result.

The provider observes the subprocess close event. If the child does not exit within five seconds of close, it sends SIGKILL. Only then does it publish the terminal event and finish the session. A caller abort during teardown discards captured calls.

Usage deltas replace the corresponding start counts. Retrying a subscription limit would spend time without restoring capacity. The error text distinguishes quota and billing from transient load, and preserves the overflow signal Tau uses for compaction.

## Evidence and versioning

The SDK pin is `0.3.321`. It bundles CLI `2.1.321`. The lock retains all platform packages. Nix passes only the current system's binary record to its npm importer. A Darwin dry run before filtering requested eight binary archives. The filtered graph requested one. Session records use `claudeCodeVersion` from the SDK manifest.

This change did not run the SDK's prebuilt Linux binary. On NixOS or in Tau's Linux image, the SDK may need a compatible executable.

The quota-free fixtures project Q3's text and Q7's parallel calls from the 2.1.311 probe logs into SDK stream events. They retain arguments, block order, stop reasons and token counts. The server name and thinking signature are test values. Delta chunk boundaries are reconstructed, not a wire recording.

The fake accepts an SDK query, reads real session files and launches a Node child through the supplied spawn callback. A real MCP client issues a parked call. A SQLite reopen test checks that durable tool results survive an interrupted continuation without executing the tools again. The opt-in live test checks the pinned binary, account metadata, fences and exits. The bundled Haiku smoke observed seven first-party subscription gates, seven message stops, and seven process exits. The three intentional interrupts exited with code 1. The four text completions exited with code 0. None required a signal. Requalify these on SDK upgrades.

## Transcript cache

CLI 2.1.311 rendered per-query reminders from its own attachment rows. Rebuilding from Tau's transcript lost those reminders. The recreated prompt matched only the system prompt and tools in Anthropic's cache.

At a tool fence the CLI recorded an assistant tool call, a rejected tool result, a prompt snapshot, and an interruption message. Appending Tau's result did not select the right branch. Selecting a resume row alone still sent the rejection. Probe 5 removed the rejection and its descendants, attached Tau's result to the final tool call row, and resumed at the new result row. It returned the expected answer, 46.

| 2.1.311 request | Cache write (tokens) | Cache read (tokens) |
| --- | ---: | ---: |
| First tool call | 9,710 | 0 |
| Second tool call | 203 | 9,710 |
| Final answer | 201 | 9,913 |

The live test repeated the sequential tool sequence through the provider on CLI 2.1.321. Its three requests wrote 9,599, 148, and 148 tokens. They read 0, 9,599, and 9,747 tokens. Both continuations read the entire previous prefix. The short text follow-up and parallel tool sequence reused their session IDs but reported no cached tokens. No change to the pruning rule was needed.

The record uses pi-durable's conversation ID as its key. It stores message digests without timestamps, the model, CLI version, effective system and tool digest, pending call IDs, and the assistant row UUID. The provider checks the recorded chain's digest before reuse. The transcript must extend the recorded prefix with the pending results or new user messages. The compiler still picks the prompt and groups results before user steers.

The provider follows parent links back from the published row. This keeps the CLI's attachments and drops interrupted branches and abandoned turns. It appends any new history rows and resumes at the final row. A mismatch imports the whole transcript into a new file. A successful replacement removes the superseded file. A failed turn invalidates the record.

The provider replaces files by rename. An exclusive lock serializes changes for one key. A busy key, missing ID, or `cacheRetention: "none"` uses a throwaway without changing the record. A stale lock costs cache hits, not conversation history.
