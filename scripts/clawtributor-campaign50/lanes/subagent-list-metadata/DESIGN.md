# Final metadata projection proof — draft

Source remains parent8964 with Node24.20.0/pnpm12.3.4. Candidate production is the original one-call projection selection, unchanged bytes9837dd7e, net−1. Final PR regression is consolidated into the existing real-SQLite list suite; full candidate10fe5bc1, tests9004d3c0 and productionf0bed73d are frozen alongside the two-file manifest. No target code has executed locally.

The wrapper is deliberately sequential:

1. Verify clean exact baseline/source/runtime, apply only the consolidated regression overlay, and run that exact case. Require ordinary exit1, exactly one failed named assertion, no passed cases, exactly one failureMessages entry with the genuine20→0 decode mismatch. Complete JSON/verbose summary, Failed Suites/global-error and file-identity guards reject loader/setup/hook/other failures.
2. Reverse only that test overlay, apply only the reviewed production delta, and run the previously accepted real tool/SQLite green driver and uninstrumented measurements unchanged. Its pre-seed gate sees only the expected owner mutation, while the existing independent input/output/full-read/update/visibility/child controls remain intact.
3. Apply the consolidated test overlay and run the complete list, active-context and subagents-tool test files individually, verifying each recorded file actually ran/passed and the new regression is among the passed cases. Capture actual per-file counts, including any intentional skips.
4. Compare all four complete public tool outputs against the exact accepted baseline artifact, require zero unnecessary decoding and matching final owner/test hashes. Retain both measurement sets as observations from their respective hosted runs, without timing/RSS thresholds or inflated speedup claims.

The shared completed-report.mjs is byte-identical to the accepted controller helper at harnessb98c0bf. Personally inspected the integrity-verified Vitest5.0.0 archive against the exact8964 lock: JsonReporter ignores global errors and emits one failureMessages element per test error; BaseReporter emits Failed Suites/unhandled summaries. The repository's vitest patch changes cache/pool/config code before13324 and after20618 in the same chunk, not the inspected14058/16778/17784 reporter functions. The strict reader therefore pairs JSON with completed verbose summaries rather than relying on a nonexistent global-error field. No runtime/package patch is proposed.

Prior actual baseline34045851221/job101520659148 is reused via baseline-lineage.json/verdict hash. It showed1000 row parses containing both prompt/report fields per nonempty list, correct output controls and uninstrumented first0.1904s/25warm1.0167s/RSS782.375→789.5MiB. The rejected wave17 fixture-mismatch run is not used as baseline. New consolidated unit coverage receives its own genuine red before green because its location/writer setup changed.

Independent final source/driver review and whole infrastructure review remain pending; no dispatch or public source publication is implied by this draft.
