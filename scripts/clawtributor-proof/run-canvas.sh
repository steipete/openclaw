#!/usr/bin/env bash
set -euo pipefail
proof_dir="$1"
evidence_dir="$2"
mkdir -p "$evidence_dir"
cp "$proof_dir/canvas-proof.mjs" .clawtributor-canvas-proof.mjs
set +e
node --import ./scripts/tsx.mjs .clawtributor-canvas-proof.mjs > "$evidence_dir/baseline.log" 2>&1
baseline_exit=$?
set -e
cat "$evidence_dir/baseline.log"
[[ "$baseline_exit" == 1 ]]
node --input-type=module - "$evidence_dir/baseline.log" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const log = readFileSync(process.argv[2], 'utf8');
const rows = JSON.parse(log.split('\n').find(s => s.startsWith('CANVAS_SELECTION_PROOF ')).slice('CANVAS_SELECTION_PROOF '.length));
assert.equal(rows.find(r => r.name === 'native-version').present, false);
assert.equal(rows.find(r => r.name === 'bare').present, true);
assert.match(log, /CANVAS_SELECTION_CONTRACT:native-version/);
const file = 'extensions/canvas/src/node-eligibility.ts';
const source = readFileSync(file, 'utf8');
assert.equal(source.split('node.platform === "macos"').length, 2);
writeFileSync(file, source.replace('node.platform === "macos"', '/^macos(?:\\s|$)/i.test(node.platform ?? "")'));
JS
git diff --check
git diff -- extensions/canvas/src/node-eligibility.ts > "$evidence_dir/candidate.patch"
node --import ./scripts/tsx.mjs .clawtributor-canvas-proof.mjs 2>&1 | tee "$evidence_dir/candidate.log"
node scripts/run-vitest.mjs extensions/canvas/src/tool.test.ts extensions/canvas/src/widget-presenter.test.ts extensions/canvas/src/cli.test.ts 2>&1 | tee "$evidence_dir/candidate-tests.log"
sha256sum extensions/canvas/src/node-eligibility.ts > "$evidence_dir/candidate-sha256.txt"
git rev-parse HEAD > "$evidence_dir/baseline-sha.txt"
