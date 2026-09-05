# Campaign proof harness

Task-owned harness for the 50-fix campaign. Publish only on the personal fork's
`codex/clawtributor-campaign50-proof-20260905` branch; never merge upstream.
Prior campaign proof files and branch history remain intact.

Each push runs the reviewed `matrix.json` against exact source commits. Workflow
concurrency serializes runs; at most two proof jobs execute concurrently. Do not
push successive waves while an earlier queued run still owns required evidence.

All runners are explicit GitHub-hosted Ubuntu images. Checkout credentials are
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
