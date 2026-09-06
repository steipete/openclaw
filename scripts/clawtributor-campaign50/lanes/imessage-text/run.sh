#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == compare ]]
cd "$target_dir"
node - "$lane_dir/lineage.json" <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const lineage = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), lineage.base_head);
const lane = path.dirname(process.argv[2]);
for (const [name,expected] of [['candidate.patch',lineage.tail_candidate_sha256],['tests.patch',lineage.test_overlay_sha256]]) {
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(lane,name))).digest('hex'),expected,name);
}
NODE
git diff --exit-code
bash "$lane_dir/run-phase.sh" "$target_dir" "$lane_dir" "$evidence_dir/baseline" baseline
git diff --exit-code
git apply --check "$lane_dir/candidate.patch"
git apply "$lane_dir/candidate.patch"
bash "$lane_dir/run-phase.sh" "$target_dir" "$lane_dir" "$evidence_dir/candidate" green
git diff --check
cp "$lane_dir/lineage.json" "$evidence_dir/prior-evidence.json"
cp "$lane_dir/candidate.patch" "$evidence_dir/candidate.patch"
