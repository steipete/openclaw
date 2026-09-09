# Campaign proof harness

Task-owned Node #142322 proof branch for the 50-fix campaign. Publish only to
`steipete/openclaw` on `codex/clawtributor-campaign50-node142322-20260909`; never merge upstream.
This branch starts at committed `4e19a001e28038df9088242c3e863b3a48d1a5e1`. Its new proof scope is
only the reviewed `node-engine-guidance-remaining-guards` lane and one matrix row.
Previously committed campaign history remains unchanged; unpublished held lanes
are not copied into this branch.

Each push runs the reviewed one-row `matrix.json` against its exact source commit.
The shared `clawtributor-campaign50-proof` concurrency group remains unchanged and
serializes campaign proof workflows. Publish only after the controller verifies
no campaign proof run is active or pending and records an explicit run grant.
The controller owns one exact run watch and one artifact cache. No automatic
retry or second push is authorized by a failed or incomplete run.

Runners use explicitly selected GitHub-hosted images. Checkout credentials are
not persisted. Target installation and execution receive an allowlisted process
environment and a fresh HOME, with no repository secrets or hydration. The source
packageManager must agree with the reviewed manifest, and Node/pnpm versions are
exact. This is source isolation, not a guarantee against dishonest test output.

Every lane has `run.sh TARGET_DIR LANE_DIR EVIDENCE_DIR MODE`. A lane's baseline
must fail for its named behavior, never merely for an arbitrary nonzero status.
Record actual final effects, source identity, controls, and whether services or
providers were synthetic. Installation failures fail the job and retain logs.

First wave proves #137219 with actual distribution ffprobe 4 and 6, synthetic
media files, real descriptor/buffer/inbound paths, and focused regression tests.
Debian 12 / ffprobe 5 and subsequent reviewed browser/runtime lanes follow as
separate matrix updates. Artifacts are retained for 14 days; copy them into the
durable campaign evidence directory promptly.

The shared Linux and macOS bootstraps own `bootstrap-final-working-tree.patch`.
A lane that captures or seals its own patch owns `final-working-tree.patch`; the
bootstrap never overwrites it. Readers of a new bootstrap snapshot use its
bootstrap-prefixed filename. Historical artifacts keep their original names
and hashes. Lane-local bootstraps must also use a distinct owned filename.
