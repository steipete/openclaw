# QA shard 48 diagnostic comparison

This proposal runs the unchanged canonical QA config, shard 1/3, on two fresh GitHub-hosted Ubuntu 24.04 jobs. The task owner has enabled workflow admission and execution binding for this reviewed, source-bound comparison. No product, regression test, dependency, local checkout or Git ref is changed by this packet. No controller, test, build or product code was executed while authoring it.

The comparison uses merge `3ba6a62a352ea58d5999a9ed4c04b9de9479377f` (tree `842c018ecd7e8141cbe6e27e238698539413899b`) and its first parent `5aaafb76c427d383e5eefc8a6934f895dd82880e` (tree `c834ca640c5a97a9e9166b13f34a5869e512c6c9`). The merge's second parent is `876101775afc88f7df842795219177f1594baceb`. These are a fresh current-merge comparison, not verified original failed CI checkout identities and not proof of the newer PR head. The exact descriptor came from the retained hosted manifest run `33830528502`; its original-CI-identity field is false.

## Workload and prerequisite

The workload is `checks-node-changed-extensions-config-48`, config `test/vitest/vitest.extension-qa.config.ts`, extra arguments exactly `["--shard=1/3"]`, one plan, `pretest_build_mode: private-qa`, no downloaded dist, Go prerequisite, targets or include-pattern override. The nominal descriptor runner is Blacksmith; the proposed actual runtime is hosted Ubuntu and records its environment, OS release, `nproc`, CPU and memory facts.

Each job uses pinned Node 24.19.0, bundled Corepack, and the exact `packageManager` integrity for pnpm 12.1.0. Its isolated install is:

```text
pnpm install --config.ignore-scripts=false --config.engine-strict=false --config.enable-pre-post-scripts=true --config.side-effects-cache=true --frozen-lockfile --prefer-offline
```

The shared enabled-cache MISS roots are configured **before installation**, then retained unchanged through install, build and test. This corrects the inherited small8 controller's cache ordering. The actual Actions `hashFiles` value uses the canonical transform-input patterns with only a `source/` checkout prefix, and the canonical generation marker is written. Vitest/Node writer flags remain zero and Node portability one. No historical seed is restored, no cache is published, and writer zero is not a claim that runtime cache writes are disabled. Each matrix job has a separate checkout, HOME, temporary namespace, pnpm/Corepack and cache state. The runtime's native Vitest child still applies its own compile-cache-safe environment.

After install, the unchanged CI resource formula selects six workers at >=12 actual cores, four at >=6, otherwise three, capped at `nproc`. Build uses:

```text
NODE_OPTIONS=--max-old-space-size=8192
OPENCLAW_BUILD_PRIVATE_QA=1
VITEST=1
pnpm build qaRuntime
```

Those private-QA/Vitest values are build-phase only. This is the canonical runtime profile, not a full build, `ciArtifacts` substitution, speculative declaration build or skip-build override. The native test wrapper's own `prepareVitestRuntime` freshness check remains active.

The subsequent command is exactly `node --import tsx scripts/ci-run-node-test-shard.mts`. The descriptor config/env is passed via the canonical `OPENCLAW_NODE_TEST_*_JSON` values; base extra args remain `[]`, group extra args provide the single shard argument, and all target/include/group overrides remain null. The parent no-output window remains 300000ms with one native no-output retry. Native heartbeat, threads, non-isolated runner, test/hook timeouts, compiler worker ownership, inner parallelism and ordering are unchanged. No external retry, new heartbeat, forced timeout, alternate test command or product seam is introduced.

## Observations and failure meaning

No JSON reporter is added. Canonical verbose and GitHub Actions output stays intact in bounded stdout/stderr. With one config, the native report-owner aggregation is absent; adding a shared JSON destination could overwrite an earlier native retry's report. The retained console instead preserves the actual native start/retry/timeout/test summary and failure text from every attempt. The diagnostic does not fabricate a count, claim parsed per-case coverage, or turn a missing test report into a pass. The native sequencer retains actual shard membership and ordering; fresh caches cannot reproduce a historical warm-cache execution order.

Every executable command records its exit code, termination, leader/group facts, duration, log sizes and hashes. Installation, qaRuntime build and shard have separate source checks and retained ownership snapshots. The native shard's exact begin/end receipts and numeric code must agree with the joined command. Build nonzero prevents test admission. A complete observed build/test failure keeps `passed: false` and exits nonzero; it is never expected-success. Setup failure, deadline, source/index/lock drift, missing native terminal receipt or uncertain cleanup leaves `diagnosticComplete: false`.

The two lanes use matrix fail-fast false. Both green means this fresh comparison did not reproduce the historical failure. Equal failures can establish that boundary on the baseline under this setup. Merge-only failure requires investigation of the actual failing path before attributing it to the PR. There is no landing verdict or speculative cause in this packet.

## Integrity and lifecycle

The inherited small8 controller's complete tracked-byte, tree/parent, real-index bytes, staged-entry/flag, immutable proof asset and installed-lock guards are retained. Porcelain comparisons still operate on an exact private index copy preserving index mtime; real index bytes are checked around each Git read. Raw index diagnostics remain bounded and retained. No source overlay is applied. Seventy-seven explicit source hashes per lane, the full exact commit tree, the unchanged 864-entry QA/config inventory and public dependency source hashes are bound.

A first-step monotonic timestamp includes checkout/setup overhead within the 60-minute hosted job, reserving 240 seconds for cleanup and artifacts. The inherited command-group owner is unchanged. Outer exhaustion is incomplete, not a product failure. The workflow uploads only the evidence directory, at most 64 MiB total with 16 MiB per file and 24 MiB total raw-index data, subject to the inherited checks. It never archives the entire HOME, dependency cache or temporary tree.

Cleanup requires joined native completion, controller group closure, unchanged source and the canonical ownership snapshot. Retained compiled workers, resource owners or dist owner/child/unjoined claims prevent scratch removal. An empty `.artifacts/dist-artifacts.lock/` parent is normal; only its meaningful owner records are treated as retained claims. Missing successful receipts alone are not independent release evidence. The canonical wrappers own nested groups and delete successful receipts, so the packet records this observation limit explicitly. Ambiguous closure retains private state; hosted disposal is not claimed as observed. Final cleanup/source checks and scratch-removal facts are retained separately. The cgroup memory high-water value is diagnostic only.

## Source evidence

All line references below are to both immutable M/B source unless noted:

- `.github/actions/setup-node-env/action.yml:250–329`: generation and enabled cache roots before `:357–385` install; package/cache actions and their ordinary flags remain unchanged.
- `.github/workflows/ci.yml:3123–3188`: canonical nondist job/setup; `:3193–3222`: actual-core worker formula; `:3236–3247`: private QA runtime build; `:3261–3283`: shard command/env.
- `scripts/ci-run-node-test-shard.mts:87–160` and `:285–442`: single native plan, group args, per-worker cache, streamed begin/end, joined workers and writer-owned pruning.
- `scripts/test-projects-run.mts:430` plus `scripts/lib/vitest-build-prerequisites.mts:24` and `:138`: QA build prerequisite and runtime freshness owner. `scripts/build-all.mts:189–266` owns qaRuntime steps and profile-level declaration policy.
- `test/vitest/vitest.extension-qa.config.ts`, `vitest.extension-config.ts`, `vitest.scoped-config.ts`, `vitest.shared.config.ts`, and `test/non-isolated-runner.ts`: actual collection, reporters, setup, file isolation and cleanup policy. QA/lab/channel trees and all test configs are identical at M/B.
- `scripts/lib/vitest-process-env.mts:129` owns the child's compile-cache-safe environment. `scripts/test-projects.test-support.mts:4380–4507` preserves explicit watchdog and native heartbeat/retry values; no direct-Gateway timeout path is used.
- `scripts/lib/vitest-worker-run.mts:133`, `scripts/vitest-process-group.mts:582`, `scripts/lib/vitest-process.mts:44–136`, `scripts/lib/vitest-resource-ownership.mts`, and `scripts/lib/dist-artifact-ownership.mts` own joined teardown and retention. Pinned fs-safe 0.7.0 `sidecar-lock.js:120` and `sidecar-lock-reclaim.js:207` remove the guarded lock file, not its parent directory.
- Locked Vitest 4.1.11 `BaseSequencer` in `dist/chunks/coverage.DM_a_rWm.js:29–89` owns hash-based shard selection and cache-sensitive ordering. Dependency source hashes are data-only evidence, not a claim of a current local dependency install.

The source pair differs only in the assertion-safety baseline, Knip config, `src/gateway/server-core-runtime.ts`, and the lifecycle test. No QA source, test, build, runner or dependency owner differs. The production fix's channel-runtime lifecycle boundary is a possible path to investigate only if the actual QA failure reaches it; no such diagnosis has yet been observed.
