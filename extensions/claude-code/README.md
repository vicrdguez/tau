# Claude Code models in Tau

Log in with `claude` as the OS user that runs the Tau server. Select your Claude subscription, not an API key. From this checkout, install the provider:

```sh
nix develop -c install-extension claude-code
```

Set the workflow's model to `claude-code/claude-haiku-4-5`, or select another `claude-code/*` model from Tau's model list. The provider follows the server's Anthropic catalog except for dated snapshots. Projects do not need to add the extension. There are no extension options.

Inference uses the CLI bundled with the extension. You do not need `claude` on the server's PATH after login. Listing models does not start the CLI, check credentials or spend quota. The first request checks the account before sending the prompt. Tau reports tokens and zero model cost. This is not a statement of your account's remaining allowance or Extra Usage charges.

| Failure | What happens |
| --- | --- |
| No Claude subscription login, API key billing, or third-party backend | The account gate refuses the prompt. Check the login as the server user. Tau does not retry an authentication or billing refusal. |
| Subscription limit reached | The turn reports quota exhaustion without retrying. Wait for the allowance to reset or choose another provider. |
| Prompt too long | Tau can compact the conversation and try again if there is history to summarize. |
| Overload, transient rate limit, server failure, lost child or timeout | Tau applies the conversation's retry policy. |
| Unsupported root tool schema or unpaired history | The request fails before launch. Check the named tool or call ID. |
| Unknown tool, malformed arguments or incomplete batch | Tau executes none of the calls in that message. |
| Caller stops the run | The provider returns an aborted turn after cleanup. |

## Working directory and Linux support

Claude Code reports its runtime directory, not the conversation's working directory. The provider tells the model to use project-relative paths for tools. In one live trial per prompt, the model used the runtime path without the guidance and a relative path with it. A full fix requires the provider to receive the conversation's working directory. `pi-durable` does not pass that directory today.

This change did not run the SDK's prebuilt Linux binary. On NixOS or in Tau's Linux image, the SDK may need a compatible executable.

## Temporary transcripts

Tau keeps the durable conversation. Each inference gets a fresh Claude Code session ID. The child runs from `<config>/tau-work`, not from the user's project. `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. Claude stores the session under `<config>/projects/<encoded-work-directory>/<uuid>.jsonl`. Session files contain conversation and tool data. The provider deletes each session and its companion directory after the child exits.

A server crash can leave a session behind. Stop all Tau servers using the profile and confirm their Claude children have exited. From the installed extension directory, print the exact project directory for the server's login:

```sh
cd ~/.tau/extensions/claude-code
node --input-type=module -e 'import {getClaudeDir,getProjectDir} from "cc-session-io"; import {join} from "node:path"; console.log(getProjectDir(join(getClaudeDir(),"tau-work")))'
```

Remove only that dedicated project directory while Tau is stopped. Leave the other projects, the profile itself and its credentials intact. The next request recreates the directory. The provider does not sweep old files.

## Verification

`nix develop -c test extensions/claude-code` runs without a subscription. The optional smoke test spends quota. Run it from a prepared checkout, after the focused tests:

```sh
nix develop -c env CLAUDE_CODE_LIVE=1 node extensions/claude-code/test/live.test.ts --live
```

It requests one text answer, one single-tool round and one two-tool batch with `claude-haiku-4-5`. It makes at most five SDK queries. The default test runner never passes `--live`.
