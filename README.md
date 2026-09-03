# macOS packaged worker containment candidate

Secretless GitHub macos-26 proof for OpenClaw PR #135663 at 1dd2887cb5ad9a2297598065dcccdc63c73f863c. Baseline run33703443197 reproduced a stopped worker surviving its app-owned launcher; its separate expected-RED outer closure receipt is unconfirmed and its namespace was retained.

This exact candidate must pass all27 owner tests and both normal and stopped-worker scenarios with one directly owned process and no worker remaining when owner.stop returns. Source/index/lock/runtime and proof-fixture cleanup guards remain mandatory. Fresh builds use the candidate dependency graph, including current Swift pins; this is no proof of unrelated Accessibility or provider behavior.
