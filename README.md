# Inert channel registry owner RED/GREEN proposal

This is a reviewed, baseline-bound diagnostic for **only** `src/gateway/server-channels.test.ts`. It uses one fresh GitHub-hosted Ubuntu 24.04 job per publication: baseline first, then candidate after root reviews the actual RED artifact. The baseline is bound to `1d713a71b11f659c3c8ebdc26c387856ae991d6e`, tree `271bd93e9732efcc11d8417bb40cc6d2025848e0`, parent `9a2b836359cf18f6762937d189eb4de5879cd368`, on `steipete/openclaw` branch `codex/round10-channel-registry-repro`. Its 50 explicit source hashes were read from exact Git objects. Candidate source and observed test inventory remain unbound. The task owner has enabled only the bound baseline workflow. Root owns source commits, final bindings, review, publication and execution. No product/test/checker/controller execution, Git mutation or public/CI action occurred while authoring this packet.

Existing reviewed workflows are closed workloads: the old candidate proof requires a full build and three lifecycle/restart/generation files; small8 requires its 61-file descriptor. Neither accepts this one-owner command unchanged. This proposal narrowly adapts the reviewed latency controller's complete guards and QA-reviewed cache-before-install setup, plus the already reviewed single-file JSON parser. It does not introduce a general-purpose command framework. The restart sibling and lifecycle test remain outside execution scope until explicitly assigned.

## Source and proof admission

Root binds each complete source checkout in the personal fork `steipete/openclaw`: exact head/tree/parents and every required source hash. The baseline source contains the permanent regression test against the original owner; the later candidate contains the same permanent test bytes and reviewed owner repair. No runtime overlay is applied. The controller verifies HEAD/tree/parents, full tracked bytes and index, explicit hashes, frozen installed lock and immutable proof assets.

`regression-reference.json` preserves the worker's source-only draft evidence, not final execution authorization. Its new case is `server-channels auto restart keeps channel hooks and snapshots bound to their Gateway registry`; the projection assertion has the custom message `channel manager borrowed another Gateway registry`. The original draft test hash is `8a66b3bb2ce07f8193e0791bb422a7b96905a8babf65ab8eb4fe2cc088447cf3`, before root formatting. The root-formatted draft is now `1c8d9e591e152332f9577069ee06e21c54a50db24bc217bc2c79216402ee511d` (message line 427, matcher line 428), bound to the root-reviewed baseline source above. Root inspected the final assertion, original mismatch, setup and cooperative lifetime cleanup; independent review was clean (0.94). The reviewed test contract is recorded before root enabled baseline admission.

The baseline contract requires one exact reviewed failed case and its reviewed failure fragments, with every other collected case passing. The parser rejects empty/multiple/wrong files, pending/skipped/todo cases, file/hook/module errors, runtime/unhandled errors and incomplete native cleanup. It observes the full expanded inventory from the real JSON report; it does not guess parameterized titles or counts. A matched assertion is recorded separately from root's required review of the complete actual failure projection. The controller does not claim that matching one error message independently proves every projected value.

The baseline job **still fails normally**: native exit 1 is required, `passed` stays false and the controller exits 1 even when the intended RED assertion matches. No expected-nonzero result is manufactured into a green check. Root reviews the raw failure/report, verifies the exact ownership mismatch and cleanup, then binds the observed full names/count and baseline report SHA256 for the candidate publication. Candidate admission requires that retained inventory binding. GREEN requires the identical test inventory, native exit zero and every case passed. Any different failure remains failure/incomplete evidence, never an accepted substitute.

## Canonical command and environment

The command is:

```text
node scripts/run-vitest.mjs run src/gateway/server-channels.test.ts --reporter=verbose --reporter=github-actions --reporter=json --outputFile=<owned-evidence>/owner-regression.json
```

No `-t` filter, explicit alternate config, shard, test overlay or sibling selection is introduced. At the inspected frozen source M, the native path delegates explicit files to `test-projects`; canonical Gateway-server ownership includes this file and unit-fast discovery explicitly excludes Gateway files. The normal prerequisite owner decides whether preparation is required. There is no speculative full build or skip-build flag.

The extra JSON reporter is the existing native end-of-run reporter used by the prior owner proofs. Verbose/GitHub Actions output is preserved. Direct inspection of locked Vitest 4.1.11 `JsonReporter` confirms it serializes actual collected task names/status/failure messages on `onTestRunEnd`, and writes its output after those results; it does not select cases, change assertions or alter retries. `file.message` comes from file-level errors rather than ordinary assertion failures. Source and line/hash evidence is in `reporter-contract.json`; its compatibility must be rechecked against the final source's locked dependencies before binding. The complete report and stdout/stderr remain artifacts.

Node 24.19.0, bundled Corepack and the exact pnpm 12.1.0 integrity pin follow the reviewed controller. Canonical installation retains:

```text
pnpm install --config.ignore-scripts=false --config.engine-strict=false --config.enable-pre-post-scripts=true --config.side-effects-cache=true --frozen-lockfile --prefer-offline
```

Both fresh private cache roots, actual Actions transform generation, writer flags zero and Node portability one are set **before install**, then reused through the native test/prerequisite flow. This is enabled-cache MISS behavior without restored historical seeds or publication. Each publication has an isolated checkout/HOME/temp/cache. No credentials, hydration, real-user configuration or external channel/provider calls are supplied by the controller.

The controller does not set worker, no-output, retry, heartbeat, test or hook overrides. It preserves native `run-vitest`/`test-projects` policy. At reference M, test-projects selects the greater of its 15-minute default and the Gateway project's measured 40-minute silence floor; in CI-like runs it does not retry unless explicitly requested. This is native policy, not a new diagnostic timeout. Root must recheck these contracts on the final source. The inherited outer 60-minute job budget and 240-second cleanup/artifact reserve still bound the entire run; exhaustion is incomplete, not product failure proof.

## Integrity and cleanup

The reviewed source/tree/index/stage/flag/lock/asset/process primitives remain unchanged. Porcelain comparison uses the exact private index copy and preserves its stat input; raw real-index bytes stay guarded and bounded. Installation and test are separately recorded, with source checks before/after and native ownership snapshots. Ordinary numeric nonzero is a test result only after joined command completion and source/cleanup checks.

Native owners retain authority over compiled workers, nested process groups, pipes and resource claims. Retained workers/resource owners or dist owner/child/unjoined claims prevent scratch deletion. An empty dist-lock parent is not a retained claim. Missing successful receipts alone never prove release. The controller separately records outer-group closure and final removal facts; it does not claim hosted-runner disposal was observed. Uncertain cleanup retains owned state and marks the result incomplete.

Only bounded task evidence is uploaded: stdout/stderr, the single-file report, actual observed/verified case rows, source/index/lock checks, platform/cache policy and ownership/cleanup receipts. Whole HOME/dependency/cache/temp trees are not uploaded. The baseline's normal red status leaves artifact upload enabled through `always()`.

`reference-source-bindings.json` records read-only hashes from M solely to identify inherited contracts. Baseline execution hashes were separately checked against 1d713a71; every candidate execution hash remains null. Reference hashes were not silently promoted into execution facts. `controller.diff`, `workflow.diff`, `guard-equivalence.json` and `static-seal.json` describe the inert adaptation. No result here is a repair verdict, a current-head CI result or a landing recommendation.

The bound-source preflight found real M→1d differences and retained them: the older canonical process owner keeps the shim-provided `TSX_DISABLE_CACHE=1`, its lifecycle/retention implementation is unchanged, and the worker declaration/selector deltas concern other entrypoints. This proposal does not change that cache policy. The setup action, package-manager integrity, Vitest 4.1.11 and both Vitest patches are unchanged; the frozen lock also preserves the source’s different oxfmt/noVNC dependencies. See `source-preflight.md` and `source-contract-diff.patch`.
