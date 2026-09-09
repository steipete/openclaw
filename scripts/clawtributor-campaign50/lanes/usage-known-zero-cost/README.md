# Usage known-zero cost hint proof packet

This packet is unexecuted. It prepares one ordinary Control UI presentation comparison at source `7f7aeb699013db4400f9ec6cfa430168e208d7bd` (tree `7f3abda19d295d451616113e7784370b0fdfb730`). No provider pricing request, transcript replay, Gateway process, account operation, configuration change or persistence migration is part of the proof.

## Source and observed contract

The independently reviewed source proposal deletes the positive-token/zero-cost heuristic in `ui/src/pages/usage/view.ts` and retains `(insightTotals?.missingCostEntries ?? 0) > 0`. Production is +1/−11, net −10. Known recorded zero and unknown pricing are already distinct in the required `CostUsageTotals.missingCostEntries` field. The proposed UI change consumes that fact; it does not establish a new billing contract.

`tests.patch` extends the existing `ui/src/pages/usage/view.test.ts` and `ui/src/e2e/usage-cost-analysis.e2e.test.ts` owners. `product.patch` changes only the initializer. No test file, production export, feature flag, custom DTO field or test-only production seam is added. The original source is kept unchanged in the task worktree; patches exist only in this artifact packet.

## Renderer and browser oracles

The selected renderer inventory contains eight cases: known zero, known positive, unknown zero, mixed positive, three query/session/day filter restoration cases, and the existing idle-response case. Its existing idle fixture is completed with real cost-component fields instead of a partial-DTO cast, and the duplicate draft idle test was removed. No unrelated case is removed or weakened.

Baseline must complete with exactly four intended renderer failures (known zero and all three known-zero scopes), four passing controls, and exact native exit 1. Candidate must pass all eight with exit 0. Other tests in this existing file are deliberately filtered: their native status must be `skipped`, agree with `numPendingTests`, and contain no failure messages. `pending` and `todo` are rejected.

One selected browser test traverses five ordinary states on the actual Usage route with complete synthetic mocked DTOs: mixed global report, known-zero query, cleared global report, known-positive query and unpriced query. The synthetic labels are disjoint, so substring label filtering cannot accidentally keep an unpriced row in the known-zero result. It clicks the actual Avg Cost / Msg hint button, requires the Web Awesome popup and slotted text to be visible, waits for the actual public popup surface animation before bounds/observations/capture, and waits for the body to become invisible after Escape before the next filter. It checks viewport bounds, records exact numeric values/text/rows/query values, and checks that the mixed warning returns after clearing the filter. No chat send, config set/patch or session patch is permitted. The provider-status response is an empty providers array; canonical invitation dismissal is seeded.

Before the final regression assertion, all ordinary controls complete and two full 1440×900 viewport captures plus `receipts.json` are retained in an exclusively allocated scenario directory. The baseline's one browser failure must be the known-zero hint assertion; its raw receipt must show the false missing-cost sentence. The candidate must show the existing normal hint. Both keep `$0.00` and the input DTOs unchanged. Captures still require full human/agent synthetic-content inspection before publication. No video is claimed.

The test-audit value is user-observable tooltip truth and scope restoration. The credible regression is the redundant zero-total inference. Existing pricing tests already establish the DTO but do not render this hint; existing cost-analysis coverage does not distinguish known zero from missing cost. The renderer cases add boundary coverage; the browser case proves route/bootstrap/filter/visible tooltip integration.

## Native runner and report ownership

`run.sh` accepts the unchanged four-argument Linux envelope and mode `baseline` or `candidate`. It requires CI=1, actual Linux, Node24.20.0, pnpm12.3.4, exact source and available Chromium. It checks every packet input, 41 source pins, clean source/index and the fixed tree before applying only the owned patches with `git apply --index`.

The renderer uses the canonical `scripts/run-vitest.mjs` path and the exact test-name filter. Browser proof uses the canonical UI E2E config and existing shared suite/server/browser owners. No custom timeout, retry, test worker, heap, config or Chromium-missing waiver is added. Candidate-only changed checks use the immutable source as the explicit comparison base; no unresolved origin/main fallback is used.

`completed-report.mjs` comes from the current reviewed wave89 Slack reader, with only the exact current UI owner's `[control-ui-e2e] unsafe cleanup:` diagnostic added to rejection. Its native skipped-test semantics were personally checked against pinned Vitest5 JsonReporter source. It rejects unfinished JSON generation, failed suites, global errors, termination/retry/OOM/retained-owner diagnostics and unexpected native error lines. The Usage-specific validator admits only its exact named failures and source assertion spans; Slack/identity assertion exemptions were not copied. Benign no-output progress heartbeat remains allowed. No project-group summary is demanded from this direct runner.

The canonical UI suite owns normal context/browser/server retirement; `run-vitest` owns subprocess/worker completion. Cleanup errors are failures, even if a target assertion also failed. All actual command exits, reports, raw logs and failure artifacts remain retained. A failed command/reader stops the lane; it does not rerun or reverse patches as if proof succeeded.

After successful component qualification, source/index checks confirm only the expected two or three modified files with exact hashes and unchanged modes. Only then are the exact owned patches reversed and the original source/index verified again. Final phase, lane exit and outer bootstrap exit must all qualify; `receipt.json` explicitly does not claim outer completion. The bootstrap's separate `bootstrap-final-working-tree.patch` remains authoritative external final evidence.

## Dependency and preliminary checks

The source lock pins Lit3.3.3, Playwright1.62.1, Vitest5.0.0 with its repository patch and Web Awesome3.12.0 with its repository patch. The installed canonical checkout had Web Awesome3.10.0, so its implementation was not used for the verdict. A source-only read of the exact public3.12.0 archive matched lock SHA-512; the actual tooltip owner exposes the inspected `part="body"` and reflected open state. The relevant repository animation patch was read. No dependency was installed or changed locally.

Pinned oxfmt0.65 formatted artifact copies. Shell/JavaScript syntax and 22 synthetic reader-data checks passed locally; these execute no TypeScript target, browser, provider or application fixture. Their separately retained result is preliminary parser evidence, not a baseline or candidate result. Independent full packet review, controller integration review and root execution grant remain required.
