# Keel codemode failures

Every bound role and every dispatch child gets the built-in `codemode` extension. Pi tests the codemode tool itself: scripts run, `models.classify` answers, and a script can call only enabled tools that accept nested calls. Keel's tools accept calls from the model only (`src/kernel/tool.ts`). Keel tests only its own selection.

| Failure | Test |
| --- | --- |
| A bound role lacks `Codemode` in its extensions or misses one of its tools. | `roles.test.ts` checks every role. `entry.test.ts` checks the designer that Tau starts. |
| A dispatch child lacks `Codemode` or one of its tools. | `roles.test.ts` checks a resolved explorer seat. Every seat comes from `seat()` and the shared `roleBuiltIns` list. |
