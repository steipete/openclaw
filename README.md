# Runtime-loader counterfactual proof

This task-owner-enabled update reuses reviewed latency publication `2af4e9f3215144ce2cc986e065115e220b30649a` with a **byte-identical controller** and the same workflow except its exact source checkout ref. Both execution-binding activation flags are enabled for the exact reviewed source. No runtime result is claimed before execution.

The new source in `steipete/openclaw`, branch `codex/round10-plugin-runtime-loader-proof`, is `79c4ae39ee80d7f8e401ed53ac3fc087fea35705`, tree `a01f925f037d8e3f7b9fbab6a12df27dbc87564d`. Its parent is the prior instrumented source `dc314aacd5498e4addf6a65fc709aba3023b76e6`. Direct read-only Git verification found exactly one changed path: `src/gateway/server-plugins.lifecycle.test.ts`, +43/-0 test lines, zero production. Its SHA256 is `91d3f94cf1069e4133cca757328ef05cd5ac5be4c622086b80dc5efe65f09daa`. All 105 explicit source hashes were verified; the other 104 match the parent. The complete commit tree remains independently bound and guarded. No runtime overlay is applied.

The root-reviewed diagnostic fixture retains the real runtime factory and its original arguments. For the runtime module path returned by the actual SDK resolver, the fixture obtains the real `createPluginRuntime` through Vitest's module graph; other module loads use the original loader/options. The existing final ledger gains a `runtime-module-loader` observation containing actual resolved target paths and a factory-call count. The spies are restored during the existing cleanup. This is a test-only module-graph counterfactual, not a production repair. Root reviewed the exact seam and recorded independent review clean at 0.88.

## Unchanged execution

The descriptor remains byte-identical, SHA256 `1b43f70eaad6e4241a855b2665328d12a3150cc03439eb3f3ade27dc1ec108f3`: the same three ordered small8 groups containing 29, 27 and 5 files. There is one source job, no extra baseline job, no new reporter, no file-selection change and no standalone build. The native command, actual-core worker formula, parent 300000ms no-output window, one native no-output retry, heartbeat behavior and native test/assertion timeouts are unchanged.

The controller remains SHA256 `2ae3b1d2c30cac1a3aa66db4e6675cf3157207f330479aa65c32eaa69280422d`. Pinned Node 24.19.0, integrity-pinned pnpm 12.1.0, canonical four installation flags, frozen/prefer-offline install, cache-before-install ordering, fresh enabled-cache MISS roots, writer flags zero and Node portability one are unchanged. Source/index/installed-lock/proof guards, native process and resource ownership, log bounds, monotonic job budget, cleanup reserve and artifact retention are unchanged. No environment, timer, assertion or output workaround was added.

The source head/tree/parent and comparison metadata, 105-file source binding, workflow ref, this README and asset manifest are the only publication updates, apart from task-owner activation. The source-comparison data records the test-only delta. The task owner applied and verified this metadata update in the publication checkout.

## Required manual interpretation

Retained control run `33847495962` reproduced native exit 143 twice. This update runs the same ordered workload with the reviewed module-loader change. That is evidence for a counterfactual comparison; it does not establish the cause before the new result exists, and it is not a replay of a separately unverified original upstream CI checkout.

After execution, all of the following require actual artifact inspection:

- All three native groups complete, with the expected total **927 cases** checked against the actual output. The existing controller checks group completion; it does not add a new 927-case parser.
- The final behavioral ledger retains the original runtime/registry, ordering, request and cleanup invariants.
- Final timing observations are present and inspected to locate the real elapsed phase, without treating a heartbeat as product progress.
- The `runtime-module-loader` observation records at least one actual resolved target and a **positive factory-call count**. A passing test without positive interception evidence does not establish the intended counterfactual.
- Source/index/lock/proof checks, final native ownership and scratch-removal facts all satisfy their existing guards.

These manual requirements are metadata only; no new controller logic or output mechanism enforces them. If the native watchdog kills the worker before afterEach, the final ledger can remain absent. Missing timing or interception evidence stays unknown. Do not infer successful cleanup from leader exit or absent receipts alone, and do not increase timeouts or add output to make a missing ledger appear.

The same pre-existing limitations apply: temporary cache state/hardware may vary, source-instrumented results do not themselves constitute an uninstrumented PR-head proof, and confirmed positive interception plus changed outcome is needed before assigning a module-graph explanation. This packet contains no new runtime result or landing verdict.
