# Single-source small8 latency diagnostic

This proposal runs one GitHub-hosted Ubuntu 24.04 job against reviewed diagnostic source `dc314aacd5498e4addf6a65fc709aba3023b76e6`, tree `e2c3a3ad984944419da7e719d23196a3c29510e0`, in `steipete/openclaw`. Its sole parent is frozen merge `3ba6a62a352ea58d5999a9ed4c04b9de9479377f`. Root publishes the source on `codex/round10-plugin-reload-latency-merge`; the separate proposed workflow branch is `codex/round10-plugin-reload-latency-diagnostics`. The task owner has enabled workflow admission and execution binding for the reviewed, source-bound diagnostic. This authoring step ran no product, test, build, formatter, dependency operation or controller, and made no Git/public/CI mutation.

The source differs from M only in `src/gateway/server-plugins.lifecycle.test.ts`: the previously reviewed type-only correction plus final-ledger timing observations, together +57/-5 test lines. Production is byte-identical. The bound test SHA256 is `51ea15e53efe7de7e5f59f7cc64859855605b233e7aef7c69aed5e53968d961c`. All 105 explicit source hashes were checked directly against the exact Git objects, as were their M counterparts. No file overlay is applied at runtime.

## Exact workload

The controller inherits reviewed small8 publication `908351233537e5c4230e50e6d120bfe56709f127`. Its descriptor is byte-identical, SHA256 `1b43f70eaad6e4241a855b2665328d12a3150cc03439eb3f3ade27dc1ec108f3`. The three serial groups remain, in order:

1. `agentic-control-plane-agent-chat-hosted-1`: 29 files, Gateway server config.
2. `agentic-control-plane-http-plugin-ws`: 27 files, Gateway server config.
3. `agentic-commands-doctor-gateway`: 5 files, commands config.

These are 61 descriptor files, not a claimed executed test count. Native admission stops after an ordinary failed group; later groups remain not-started. There is one source job, no duplicate baseline job, no selected-file shortcut and no standalone build. The normal `test-projects` runtime prerequisite remains the build owner when needed.

The job uses pinned Node 24.19.0, bundled Corepack and the exact integrity-pinned pnpm 12.1.0 package-manager entry. It retains canonical install flags:

```text
pnpm install --config.ignore-scripts=false --config.engine-strict=false --config.enable-pre-post-scripts=true --config.side-effects-cache=true --frozen-lockfile --prefer-offline
```

Cache-before-install setup comes from reviewed QA publication `30933577c74cdaf5af9447beb3725d08ffe6e9ef`. Both private enabled-cache roots, their generation marker, writer flags zero and Node portability one are established before install, then reused by the native test/prerequisite flow. The generation is the real Actions `hashFiles` result over canonical inputs with only the source-checkout prefix added. This is fresh relocated cache-MISS state, without restored historical seeds or cache publication. Writer zero does not prohibit normal runtime cache writes. This ordering intentionally differs from the older small8 diagnostic and matches canonical CI setup; timing comparisons must acknowledge that setup difference.

The sole test command stays `node --import tsx scripts/ci-run-node-test-shard.mts`. The exact three groups, null config/target/include overrides, empty extra args and serial-plan setting are unchanged. Worker count follows canonical `nproc` scaling rather than the descriptor's nominal runner label. The parent retains `NODE_OPTIONS=--max-old-space-size=8192`, a 300000ms native no-output window and one native no-output retry. There is no new reporter, external retry, intermediate output, heartbeat, timeout floor or runtime environment workaround. Native verbose/GitHub Actions output, file sequencing, worker/compiler ownership and cleanup remain unchanged.

## Timing evidence and limits

Timing observations use process-monotonic `performance.now()` values in the existing proof's `observations` array. They are emitted only through the existing final `PROOF_126547_LEDGER` line. They surround preparation, port allocation, the actual `startTestGatewayServer` call, `startupSettled`, initial monitor/probe waits, socket/config patch, replacement registration, bound runtime and reload settlement, retired/successor checks, successful body finish, afterEach entry and each server/socket cleanup phase.

There is no extra runtime file or log mechanism. The controller retains its existing bounded small8 stdout/stderr, from which the final ledger may be inspected as data. It does not weaken behavioral ledger predicates or claim automatic per-await attribution. If preparation fails before its proof exists, or the native watchdog terminates the worker before afterEach, the final ledger may be absent. A rejected await can leave a before marker without an after marker. Successful body finish and afterEach entry are distinct, so hook time is not silently assigned to the body. Values are within one process's monotonic clock, not cross-machine or wall-clock timestamps.

A watchdog termination does not authorize increasing its window, printing heartbeats, bypassing native cleanup or adding another observation channel. Missing timing data remains unknown. The prior baseline result remains separate evidence and is not rerun here. This diagnostic source is not an original failed CI checkout, an uninstrumented PR-head run or a landing verdict. Hardware, fresh-cache ordering and the corrected install/cache ordering also limit cross-run duration comparisons.

## Integrity, lifecycle and result meaning

The reviewed small8 source/tree/parent, full tracked-byte, staged-entry/flags, real raw-index, comparison-index, proof-asset and installed-lock guards remain. Source checkout credentials must be absent. Porcelain diff still uses an exact temporary index copy with preserved mtime, and the real index is checked around reads. All proof assets and the complete source tree are pinned independently of the 105 explicit bindings.

The QA-reviewed installation handling records source state and native ownership after install even on ordinary nonzero, and prevents test admission on failure. Native closure confirmation resets before each executable phase. The unchanged small8 parser requires ordered native begin/end receipts and matching numeric exits. Logs remain bounded; source drift, an outer deadline, missing terminal receipts or unverified process/resource ownership is incomplete. Any ordinary command failure fails the job; no expected-nonzero success is manufactured.

The first-step monotonic budget includes checkout/setup within the same 60-minute job, reserving 240 seconds for cleanup/artifacts. The existing process owner records leader exit and outer-group closure while unchanged native owners govern nested processes, pipes, workers and resource claims. Compiled-worker directories, retained resource owners or dist owner/child/unjoined claims prevent scratch deletion. Empty dist lock directories are not retained claims; missing successful receipts alone never prove release. Ambiguous closure retains state, and hosted-runner disposal is not claimed as observed.

The artifact consists only of the controller's bounded evidence directory: command output/results, source/index/lock/proof checks, actual hosted/CPU policy, cache generation, ownership snapshots and final verdict. No whole HOME, dependency cache or temporary tree is uploaded. `controller.diff`, `workflow.diff`, `guard-equivalence.json`, `source-hash-verification.json` and `static-seal.json` are review-only handoff files.

The underlying contracts remain `.github/workflows/ci.yml:3193–3283`, `.github/actions/setup-node-env/action.yml:250–385`, `scripts/ci-run-node-test-shard.mts`, `scripts/test-projects-run.mts`, the native Vitest process/worker/resource owners and the exact frozen configs/tests. No production or runner contract was repaired by this diagnostic proposal.
