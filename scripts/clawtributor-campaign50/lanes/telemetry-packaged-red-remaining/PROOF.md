# Packaged telemetry baseline continuation

This lane reuses the exact package and completed controls from run34078660938. That run failed a proof oracle: OpenClaw inherits the root help command's capitalized description. The bare parent was never executed. Historical failure is preserved; no earlier baseline success is claimed.

A separate transport job downloads the immutable prior artifact, validates its ZIP and the external23-file manifest, and transfers only verified ordinary files into this run. Cross-run Actions-read credentials stay on that transport VM. This target receives current-run data and rechecks every hash before execution.

The lane performs a fresh normal install, compares dependency versions and archive-bound installed files, and checks the new installed version. It then runs the11 remaining CLI calls. Only the exact bare-parent help on stderr with exit1, all controls, source checks and cleanup passing qualifies the baseline. No build or package step is repeated. CI and existing update settings suppress telemetry requests; configuration writes are synthetic.

Retries must include transport in the same attempt: use a new reviewed campaign push or an explicitly authorized full-workflow rerun. A selective proof-only rerun is unsupported and fails before target execution when its attempt-scoped input is absent. There is no fallback to an earlier producer attempt.
