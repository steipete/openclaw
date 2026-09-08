# Fatal diagnostic sources

All repository locators below refer to exact c86263abc9c816466eb1dd7abc57bacd25cefedd and are source-pinned in this packet. No producer is changed.

- scripts/run-vitest.mts:692 emits the fixed no-output timeout/termination line.
- scripts/test-projects-run.mts:196 emits the fixed retry-after-no-output-timeout line. This packet performs no retry and must reject evidence of one.
- scripts/lib/vitest-worker-run.mts disposal emits `[vitest-workers] retaining <directory>: compiler|borrower join failed`.
- scripts/lib/vitest-process.mts:109/123 emit the two retained namespace messages when descendant or nested-resource completion is unverified.
- scripts/vitest-process-group.mts emits the group-remained-alive-after-SIGKILL error.
- scripts/lib/vitest-unhandled-errors.mts formats the final `[vitest] UNHANDLED ERRORS (<count>)` summary.

Exact Vitest5 archive tools/138411-nfc-validator-check/vitest-5.0.0.tgz is SHA256602c520b9225cbb26d7d9d749169ff0866da24dde092a87cadd4b7c8056f7268, previously bound by complete SRI to this lockfile. Bundled index.B89dZ0-N.js emits the Failed Suites count banner at16788 and pool termination failure/timeout lines at11487–11488. Bundled run.CQOUYP-x.js:3396–3403 emits Hook/Test timeout errors, including optional pending-operation text. The exact repository patch preserves those messages. Native JSON's suite status/count and success fields remain required in addition to the anchored log guards. The existing EnvironmentTeardownError and unfinished-report guards remain strict.

Node24.19's [OOMErrorHandler](https://github.com/nodejs/node/blob/v24.19.0/src/node_errors.cc#L544-L555) emits a `FATAL ERROR:` line with an optional location followed by `Allocation failed - JavaScript heap out of memory` or `Allocation failed - process out of memory`. The reader matches that complete anchored form. This source inspection and diagnostic-text matching do not generate or execute any OOM/crash input.

Node24.19's [ERR_WORKER_OUT_OF_MEMORY definition](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/errors.js#L1851-L1852) supplies the fixed worker-memory-limit prefix plus a detail string. The reader permits the native Error/code label or message-only presentation and anchors the whole line.

Data-only controls must reject each actual fatal form and nested-suite failure/pending metadata, while allowing the same words within ordinary prefixed test-title or quoted diagnostic text. No target test, planner, index mutation or reproduction is part of these reader controls.
