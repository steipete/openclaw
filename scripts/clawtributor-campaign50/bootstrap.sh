#!/usr/bin/env bash
set -euo pipefail
# GitHub assigns a fresh host. Only the explicit environment above reaches target code.
target_dir=$1
lane_dir=$2
evidence_dir=$3
mkdir -p "$HOME" "$evidence_dir"
cd "$target_dir"
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ -z "$(git status --porcelain)" ]]
node - "$evidence_dir/source.json" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const pin = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+sha(?:256|512)\.[a-f0-9]+)?$/.exec(pkg.packageManager);
assert.ok(pin, 'target does not declare an exact pnpm packageManager');
assert.equal(pin[1], process.env.PNPM_VERSION, 'manifest package manager differs from source');
assert.equal(process.versions.node, process.env.NODE_VERSION, 'resolved Node differs from reviewed pin');
fs.writeFileSync(process.argv[2], JSON.stringify({
  source: process.env.SOURCE_SHA,
  lane: process.env.PROOF_LANE,
  mode: process.env.PROOF_MODE,
  node: process.versions.node,
  packageManager: pkg.packageManager,
  engines: pkg.engines,
}, null, 2) + '\n');
NODE
finish() {
  proof_exit=$?
  printf '%s\n' "$proof_exit" > "$evidence_dir/exit-code.txt"
  git diff --binary > "$evidence_dir/final-working-tree.patch"
  exit "$proof_exit"
}
trap finish EXIT
sudo apt-get update > "$evidence_dir/apt-update.log" 2>&1
sudo apt-get install --no-install-recommends -y ripgrep > "$evidence_dir/host-tools.log" 2>&1
npm install --global "pnpm@$PNPM_VERSION" > "$evidence_dir/pnpm-install.log" 2>&1
[[ "$(pnpm --version)" == "$PNPM_VERSION" ]]
pnpm install --frozen-lockfile > "$evidence_dir/dependencies.log" 2>&1
bash "$lane_dir/run.sh" "$target_dir" "$lane_dir" "$evidence_dir" "$PROOF_MODE"
