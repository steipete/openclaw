# Independent green proof packet review

Initial packet held for validator-only refinement. Candidate source remains accepted and unchanged. Personally matched all PACKET.json file hashes, all 36 baseline hashes against cb4, all 34 unchanged candidate owners and both candidate file hashes, and both patch files byte-for-byte against the reviewed native index relative to cb4. The wrapper applies only tests before intended red, then production before candidate validation; no top-level candidate overlay may precede it.

Direct comparison with immutable 653c/ca94 baseline driver confirms identical three-ID fixture generation, CLI args, environment, capture and cleanup. Only expected candidate collision exit/issues, completion phase and marker change. The existing real CLI red is reused honestly. Read actual native vitest-report-owner and capture source: original attempt records, outcomes and teardown counts support the proposed first-attempt/native-capture checks; aggregate replay's ignore flag is derived separately and is correctly not treated as the original setting.

Two concrete validator gaps remain in initial verify-tests hash 77c4f98263e36dc88fd5baae7e85cfc2524334379ce6d43b48dc02085e620373:

1. Baseline checks only a failed short title plus failure-message substrings reader and ambiguous-openai-route-group. Require the exact full test/file owner and the intended empty-issues assertion failure, rejecting extra diagnostics rather than accepting any sole error carrying those words.
2. Green checks suite status and at least one passing assertion, but allows skipped/todo assertions and hidden failureMessages on otherwise passed assertions. Require zero pending/todo, every assertion passed with empty failureMessages, and count agreement.

Owner, parent and controller were notified to hold final packet acceptance until those validator-only refinements are frozen and reviewed. No target runtime, test, build, source/ref/public mutation or duplicate download was performed. This note is artifact-only.
