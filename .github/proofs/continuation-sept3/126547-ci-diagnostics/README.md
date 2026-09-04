# Gateway reload CI diagnostics

This runs canonical checks on the fixed baseline and candidate. Actual status is recorded in each Actions run and its artifacts; this diagnostic workflow does not replace the upstream PR gate. It adds no upstream workflow or product edit.

## Exact sources and isolation

Two independent `ubuntu-24.04` GitHub-hosted jobs use the same seven commands with fail-fast disabled and maximum parallelism two. Candidate `44e05b0e17ff48dddf4afadf152a7fabdce02cf6` from the public fork has tree `7a6318339507be55d4fe84f0fda07a96226de84f`, identical to official PR head `74d8d8023b7b0fb693e20c8d4f50dfee34f585e3`. Baseline is unchanged official main `d2a616bdf373a5b3cac0add8e9b2f70cd0802f42`. Each lane has 129 immutable source hashes. Only `src/gateway/server-core-runtime.ts` and `src/gateway/server-plugins.lifecycle.test.ts` differ among those bindings; every check owner, config, workflow, package manifest and lockfile is identical. Full tracked files are additionally hashed before installation and checked after every command.

Actions are inherited pinned checkout v7.0.1, setup-node v7.0.0 and upload-artifact v7.0.0. Checkout credentials are not persisted. The controller gets an `env -i` allowlist of only public Actions provenance and PATH. Children receive fresh private HOME/TMP/XDG/state directories, pinned Node 24.19.0 and its bundled Corepack, integrity-pinned pnpm 12.1.0, then ordinary `pnpm install --frozen-lockfile`. No cache restore, role, secret, provider credentials, runner token, altered registry, auth/config injection, retry or product overlay is used. Runtime requires the actual GitHub-hosted Linux identity and Ubuntu 24.04 distribution. Node/Corepack/Git executables, environment names, source tree and installed lock hashes are recorded. Canonical package scripts may fetch public pinned Knip 6.32.2 through their own pnpm dlx owner.

## Seven exact commands

| Report name | Canonical command | Additional CI environment |
| --- | --- | --- |
| production-dependency-audit | `node scripts/pre-commit/pnpm-audit-prod.mjs --audit-level=high` | none |
| type-stripe-2 | `node scripts/run-tsgo-core-test-shards.mjs --stripe 2/5 --concurrency 2` | none |
| core-lint-1 | `node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1` | `OPENCLAW_LOCAL_CHECK=0` |
| extension-lint-1 | `node --import tsx scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=1/6 --threads=1` | `OPENCLAW_LOCAL_CHECK=0` |
| deadcode-dependencies | `pnpm deadcode:dependencies` | `OPENCLAW_LOCAL_CHECK=0` |
| deadcode-unused-files | `pnpm deadcode:unused-files` | `OPENCLAW_LOCAL_CHECK=0` |
| deadcode-exports | `pnpm deadcode:exports` | `OPENCLAW_LOCAL_CHECK=0` |

All command environments carry canonical `CI=true` and `GITHUB_ACTIONS=true`. No Go/heap/worker/timeout/skip flags are injected. Type stripe2 selects agents-other, commands and other through the unchanged source-owned round-robin selector. Core and plugin selectors are executed unchanged, not recreated in the controller. Diagnostics run the two lint commands and three deadcode commands independently even when an earlier command reports findings; ordinary upstream shell short-circuiting can hide those later results. This changes diagnostic orchestration only, never their arguments or pass criteria. Each command must return zero to pass, and the entire job fails if any command fails.

No additional full build is required: root TypeScript/core lint resolve source aliases, Knip scans source and excludes generated dist, and the plugin lint owner prepares its canonical package-boundary declarations itself. The upstream selected jobs also run directly after dependency setup. No build-skipping flag is introduced. Build prerequisites remain in their existing owners.

The production audit CLI has no JSON-output option: it reads the committed pnpm lock, computes production dependencies, and contacts the public npm bulk-advisory API through its unchanged implementation. The artifact contains its exact bounded stdout/stderr and a controller JSON exit verdict, not an invented advisory JSON payload or substitute `pnpm audit`. Findings include its native severity, package, advisory title/range/URL. Registry availability and advisory data are live dependencies: paired results can identify common failures, but an audit disagreement alone does not prove a source regression.

## Process closure, integrity and results

The existing controller's twelve source/index/credential/asset guard functions remain byte-identical. Raw Git index bytes, staged entries, flags, every tracked file/symlink target and installed lock remain fixed. Porcelain diff uses an exact disposable copy of the index with original mtime, while the real index remains strictly checked and retained for diagnosis. The asset manifest is checked again throughout execution. Read-only source evidence and a function-identity report accompany this proposal outside the public assets.

Each command has its own stdout, stderr, result JSON, source-guard JSON, canonical-closure JSON and verdict JSON. A normal numeric nonzero result is recorded as failed; it does not by itself mean a process is unjoined. The next command starts only after leader exit, positive outer process-group disappearance, full source/index/lock/asset checks, and inspection of the canonical declaration/build owner for retained claims or cleanup errors. Inherited nested process ownership remains in the unchanged wrappers. Knip's timeout/output-limit path does not return a final positive detached-group join, so that path stops this diagnostic lane and retains its scratch namespace. This does not claim arbitrary daemon/descendant enumeration or hosted-runner disposal observation.

A process timeout, output overflow, unconfirmed group, canonical retained claim, source drift, installed-lock drift or asset mutation stops the lane. Unstarted checks receive explicit not-run verdicts. Command deadlines are 15 minutes for audit/type/lint and 20 minutes for each whole deadcode script; existing internal limits remain unchanged. Setup has the inherited 20-minute frozen-install deadline. The 150-minute job ceiling covers those serial worst cases plus cleanup and upload, without extending a checker timeout. Output is bounded to 16 MiB per command; retained index copies have an 8 MiB individual/24 MiB total limit; evidence has the inherited 64 MiB total gate. Runtime HOME and caches are never uploaded. Scratch deletion occurs only after integrity and observed process closure; otherwise it is retained and the limitation is reported.

No expected-nonzero result can make a job green. `hosted-proof-result.json` reports each actual command status, whether all checks executed, cleanup errors, and overall pass. Its meaning is only the seven checks at that exact source, toolchain, environment and time. Compare paired diagnostic text and source identities manually before attributing a failure.

## Explicit omissions

Baseline ratchets are excluded because the original CI merge/base provenance is not pinned in this proposal; the maintainer owns the separate assertion-count repair. Node configuration48 is excluded because its actual matrix row is unavailable; no ordinal-to-command inference is used. This does not rerun the already observed Gateway lifecycle/transport proof, does not replace upstream exact-head CI, and makes no claim about the original failed job logs. Denied raw Actions logs are neither fetched nor reconstructed from another endpoint.
