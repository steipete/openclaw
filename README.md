# Gateway channel registry ownership check diagnostics

Candidate-only validation of OpenClaw PR #126547 at 7179ebe50751ae4eeb93a23a43c2da907d83cd18 on GitHub-hosted Ubuntu 24.04.

This source removes an unused import and a shadowed fixture parameter, and supplies the required attached-registry getter in the existing MCP replacement fixture. The preceding PR run failed production types, core test types and core lint; this diagnostic verifies the reviewed corrections and records any remaining errors. It does not reconstruct the original failed CI checkout.

Run the unchanged production type command, test type stripes 1/5 then 2/5, and core lint stripe 1/5 then plugin lint stripe 1/6. Each pair preserves its native failure barrier and 900-second group cap. Independent workloads continue after ordinary findings only after source, index, lock and process closure checks pass. Timeout or incomplete cleanup stops the diagnostic.

The complete five-job lint matrix establishes the selected hosted profile. Dependencies are installed from the frozen lock with no restored cache; this diagnostic makes no canonical-cache performance claim. Source/parent/tree and 150 file hashes, bounded output, secretless checkout and native cleanup remain mandatory. A separate full-build lifecycle proof and required PR CI own runtime and merge readiness.
