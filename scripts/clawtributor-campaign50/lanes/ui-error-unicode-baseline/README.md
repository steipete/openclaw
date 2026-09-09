# #142784 baseline: ordinary UI error projections

This packet has not executed. It proves only two bounded error-text projections on protected main `2bac366b0b370cdbf8b7691f106eebc3d931c5a1`. The native PR checkout remains clean at contributor head `7dd640c861e2bdb8d7648a8d219595315558fda4`; the accepted neutral production rewrite is not in this packet or adopted locally.

## Intended invocation

Use the existing secretless campaign controller: Ubuntu24.04, Node24.20.0, repository-pinned pnpm12.3.4, fresh HOME, max2 total jobs. `run.sh TARGET LANE EVIDENCE baseline` requires `SOURCE_SHA` above, `PROOF_LANE=ui-error-unicode-baseline`, `PROOF_MODE=baseline`, and `PROOF_VARIANT=ordinary-projections`. The unchanged outer workflow validates actual hosted execution before its sanitized environment. No credential forwarding, workflow change, lease, or execution is authorized by this file.

The only source overlay adds one private E2E file. No production or existing test/config file changes. Normal `pnpm exec playwright install --with-deps chromium` supplies the lockfile-pinned Playwright1.62.1 browser. Missing Chromium and external executable overrides are refused. The canonical direct `scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner` selects only that file. New files belong to the bundled project, so canonical global setup builds and serves one temporary production UI bundle. This is not an arbitrary source-module Vite substitute or a full runtime build.

## Two observable boundaries

1. A same-origin synthetic UI initializer throws one benign string with a supplementary character across the existing512-code-unit report cut. The ordinary production `ControlUiPluginRuntime` reports it through the mock Gateway. The test retains the actual outbound plugin/revision/status/error, checks normal failed status and the unchanged cap, and then asserts the projected string contains no surrogate half. Baseline qualification requires the exact511-character prefix plus a lone high surrogate, not any initialization failure.
2. The real Updates settings view receives a recorded failed sentinel from the mock `update.status` method. No update operation is invoked. The view must show the known179-character cause prefix, without the uncropped tail. It records DOM text before asserting there is no surrogate half or rendered replacement character. Baseline qualification requires the corresponding broken character immediately after that prefix.

Each native case uses the existing `suite.runScenario` and `suite.withPage` owners. Both have fresh contexts and retain screenshots before their desired assertions. Native hooks close contexts/browser/preview and release the temporary UI output. Existing test120s, hook180s, action waits, pool/fork and parent watchdog policies are unchanged. The imported catalog helper is used only to create ordinary catalog data; its unrelated module-string factory is never called.

No real Gateway, backend plugin, provider, installer, updater, admission/revocation, stale-host/retained-authority, or authentication-failure scenario is selected. The mock's normal bootstrap grants remain intact; no source authority check is bypassed or changed. No preexisting mixed-scope test table runs. These are synthetic reporting/rendering failures, not process crashes or stress inputs.

## Acceptance and failure retention

Keep the real browser command exit1. The reader requires exactly one completed file, two failed cases in declaration order, two failed native suites (file plus describe), no skipped/todo/passing/unstarted cases, and only the expected boolean assertion errors. It binds the two raw observations, normal status/IDs, exact original broken text, same worker PID, browser version and screenshots. Missing receipts, unexpected output, a passing baseline, native cleanup errors, retries, no-output termination, OOM, unfinished reports and retained resource ownership are incomplete evidence and fail the lane.

Only after strict completion and source checks does the runner reverse its exact test-only index patch and prove original source/index restoration. An unqualified run retains its overlay and final status/patch rather than restoring inputs under uncertain work. A successfully classified baseline can finish the outer job successfully, but its receipt explicitly says `isFixProof:false` and retains native exit1. Screenshots still require independent visual inspection before any publication.

The protocol/owner/formatting/helper/runtime/package/test-config source hashes are in `source.json`; all11 previously reviewed owner/helper files match the earlier8b main and shippedv2026.9.3 bindings. Current source contracts were read directly. JSON reporter semantics come from the retained exact Vitest5 archive (SHA256602c520b9225cbb26d7d9d749169ff0866da24dde092a87cadd4b7c8056f7268), its lockfile SRI, and the unchanged repository patch. The completed-log reader is reused from the accepted ordinary Usage browser envelope and must be checked against these exact source producers by the independent reviewer. A direct-config invocation has native summaries; no invented project-summary marker is required.

Candidate proof, whitespace/CRLF controls for the neutral line-selection cleanup, changed gates, fresh reviews and exact-head PR CI remain separate later obligations. This baseline does not claim any of those passed.
