# Gateway reload merge diagnostics

This fresh comparison runs canonical checks on the fetched PR merge snapshot and its exact main parent. It does not identify or replay an earlier CI checkout, and it does not establish merge readiness.

| Lane | Commit | Tree |
| --- | --- | --- |
| Merge | `3ba6a62a352ea58d5999a9ed4c04b9de9479377f` | `842c018ecd7e8141cbe6e27e238698539413899b` |
| Main parent | `5aaafb76c427d383e5eefc8a6934f895dd82880e` | `c834ca640c5a97a9e9166b13f34a5869e512c6c9` |

The merge's second parent is PR head `876101775afc88f7df842795219177f1594baceb`. Both lanes verify raw commit parents and 134 source bindings, then retain a complete source and index snapshot. Their only differences are the four reviewed PR files.

Each isolated GitHub-hosted Ubuntu job runs the production dependency audit and the current `check-test-types-core-2` workload: literal type stripes 3/5 followed by 4/5, each with the canonical two-compiler limit. Stripe 4 runs only if stripe 3 passes; the pair shares a 900-second ceiling. This follows the current paired-stripe workflow, rather than treating the job suffix as a literal stripe number. The canonical audit's own bounded timeout retry remains unchanged.

Numeric failures remain failures in separate verdicts. Audit failure may proceed to the independent type check only after verified command closure and source integrity. Failed stripe 3 explicitly marks stripe 4 not run. Timeouts, output overflow, source/index/lock drift, and unconfirmed process ownership stop the lane. No product overlays, checker-policy overrides, additional retries, or timeout increases are introduced.

The workflow pins source and runtime versions, disables persisted checkout credentials, and passes a private environment without secrets. Artifacts retain bounded command output, actual exits, source and index identities, installed-lock hashes, observed canonical ownership/closure, and scoped scratch cleanup. Overall success requires all three checks and every integrity/cleanup check to pass. Live advisory-service results are observations, not code-regression attribution by themselves.
