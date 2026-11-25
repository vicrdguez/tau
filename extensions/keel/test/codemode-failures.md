# Keel codemode failures

Every bound role and every dispatch child gets the built-in `codemode` extension. A script can call only the tools its role already has.

| Failure | Test |
| --- | --- |
| A bound role lacks `Codemode` in its extensions or misses one of its tools, so the model has no `codemode` tool or a script's `models.classify` fails. | Check `settings()` for every role. Run a designer script through the harness that reads a file and classifies with a mocked classifier. |
| A dispatch child lacks codemode. | Resolve an explorer seat, an arena seat and the sweeper seat and check their extensions and tools. Run a script in a dispatched child. |
| A script reaches a coding tool its role does not have. | Run a coordinator script that calls `tools.bash`. The call fails and no command runs. |
| A script calls a Keel tool, which would bypass expectation and citation checks. | Run a worker script that calls `tools.record_ruling` and `tools.file_finding`. Both fail, and Keel records no ruling and no finding. |
| The extension list for bound roles and the one for dispatch seats drift apart. | Both read one shared list. The roles test compares them. |
