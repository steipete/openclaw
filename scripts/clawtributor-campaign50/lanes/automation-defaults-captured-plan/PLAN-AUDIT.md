# Complete captured plan audit

Exact source: 74fd11e05f2d5730dc03a67e27cc2d227ca5b339. Captured run34195063822/job101960912089 printed the complete30-command actual plan before its expected-plan assertion failed. The17-name prefix exactly matches the completed69 summary; all13 suffix names are now paired with exact source-reviewed arguments in plan-contract.json. Counts are derived from those bound arrays.

`changed-lanes.mts` selects core/core-tests for the two paths. `getChangedCoreTestPaths`126–135 returns undefined because core production is included, preserving the full canonical core-test driver. `check-changed.mts` finishPlan533–544 moves every broad audit after the final typecheck and before subsequent lint. Coercion declarations are unconditional; deprecation applies to core paths; dead-export applies because `DEADCODE_SOURCE_PATH_RE` matches src/config/*.ts and no truthy skip suppressed the captured selector. Neither createChangedCheckChildEnv nor resolveLocalCheckEnv sets/deletes that skip option. No new skip or environment override is added.

The remaining order and default CLI ownership are:

| Order | Check                  | Owner/default invocation reviewed                                                                                                                              |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Core test types        | tsgo:core:test → run-tsgo-core-test-shards.mjs/.mts; no group, stripe or concurrency override; normal all-shard loop and managed compiler completion.          |
| 2     | Coercion declarations  | check:coercion-helpers → check-coercion-helper-declarations.mts; no flags, full tracked-source/default owner classification.                                   |
| 3     | Deprecated API usage   | check:deprecated-api-usage → check-deprecated-api-usage.mts; no --rule filter, all declared rules.                                                             |
| 4     | Dead exports           | Direct node --import tsx scripts/check-deadcode-exports.mts; all three canonical Knip scans, existing version/timeout/buffer/cleanup policy.                   |
| 5     | Core lint              | Direct run-oxlint.mjs with config/tsconfig/oxlint.core.json and both sorted changed paths; normal type-aware/resource wrapper, no focused-config or skip flag. |
| 6     | Native schema versions | Direct check-native-state-schema-version.mjs; compare existing Swift/TypeScript declarations, no writes.                                                       |
| 7     | Database-first guard   | check-database-first-legacy-stores.mts main; default source/native roots, source AST/string analysis, no database operation.                                   |
| 8     | Media helper guard     | check-media-download-helper-roundtrip.mts; tracked plugin source text, normal test/fixture exclusions.                                                         |
| 9     | Runtime sidecar guard  | check-runtime-sidecar-loaders.mts; default source roots and existing tsdown entries, source analysis.                                                          |
| 10    | Import cycles          | check-import-cycles.ts; default src/extensions/scripts runtime-edge graph and standard source exclusions.                                                      |
| 11    | Webhook body guard     | check-webhook-auth-body-order.mts; unchanged runCallsiteGuard defaults and repository allowlist, source analysis only.                                         |
| 12    | Pairing store guard    | check-no-pairing-store-group-auth.mts; unchanged default source context and source violations.                                                                 |
| 13    | Pairing account guard  | check-pairing-account-scope.mts; unchanged default source context and source violations.                                                                       |

Every alias is compared with exact package.json text before execution. Direct bin/args are compared as complete arrays. Entry points/defaults were personally read for every owner; large AST guards were inspected at their import/default-root/CLI boundary rather than newly auditing thousands of unchanged rule implementation lines. The metadata repair changes none of these owners or policies. Their exact source hashes and relevant loader/config owners are checked before/after.

The previously reviewed managed runner remains unchanged: native command environment, strict process-tree completion, natural status0, close/EOF/no signals, exact shim cleanup ownership and final source/input guards. The outer loop must execute every derived remaining command. Missing, extra or reordered canonical commands fail before execution; no missing-check tolerance or timeout/resource adjustment exists.
