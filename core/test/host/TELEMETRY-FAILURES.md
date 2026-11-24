# Telemetry failure list

| Failure | Test |
| --- | --- |
| A tool's histogram or span attribute is missing after the server drains telemetry and restarts. | telemetry.test.ts |
| A tool records `NaN` or `Infinity` and faults the run or fails the conversation. | telemetry.test.ts |
| A corrupt `telemetry.sqlite` prevents a project from opening, fails to log the error, or lets read calls succeed without telemetry. | telemetry.test.ts |
| An accepted answer records no wait or records it twice. A repeated or refused answer records another wait. | telemetry.test.ts |
| `trace` does not return `unknown_trace` for an unknown ID. | telemetry.test.ts |
| `traces` paging loses or repeats a trace, accepts a cursor from another call or project, or accepts a changed filter. | telemetry.test.ts |
| `traces` accepts a cursor with an invalid query or position. | cursors.test.ts |
| `telemetry` omits a core source or a loaded extension's schema, or accepts a malformed or foreign schema. | telemetry.test.ts |
| The entry set or README rows drift. | core/test/store/exports.test.ts, core/test/extension/exports.test.ts, tools/workspace.test.mjs, e2e/test/loader.test.ts |
