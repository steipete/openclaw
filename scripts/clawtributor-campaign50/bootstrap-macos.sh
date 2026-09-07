#!/usr/bin/env bash
set -euo pipefail

target_dir=$1
lane_dir=$2
evidence_dir=$3
task_root=$4
mkdir -p "$evidence_dir"
phase=identity
finish() {
  proof_exit=$?
  trap - EXIT
  printf '%s\n' "$proof_exit" > "$evidence_dir/exit-code.txt"
  printf '%s\n' "$phase" > "$evidence_dir/bootstrap-final-phase.txt"
  if [[ -e "$evidence_dir/native-process-cleanup-incomplete.json" ]]; then
    proof_exit=1
    printf '%s\n' skipped-incomplete-native-process-cleanup > "$evidence_dir/source-diff-capture.txt"
  elif ! git -C "$target_dir" diff --binary "$SOURCE_SHA" -- > "$evidence_dir/final-working-tree.patch"; then
    proof_exit=1
    printf '%s\n' failed > "$evidence_dir/source-diff-capture.txt"
  fi
  if [[ "$proof_exit" == 0 && "$phase" == lane-complete ]]; then
    # The lane must finish its owned commands before returning success.
    if [[ "$task_root" =~ ^/tmp/oc-proof-[A-Za-z0-9]+$ && "$HOME" == "$task_root/home" ]]; then
      if rm -rf "$task_root"; then
        printf '%s\n' removed-after-lane-success > "$evidence_dir/bootstrap-home-cleanup.txt"
      else
        proof_exit=1
        printf '%s\n' removal-failed > "$evidence_dir/bootstrap-home-cleanup.txt"
      fi
    else
      proof_exit=1
      printf '%s\n' refused-unexpected-task-root > "$evidence_dir/bootstrap-home-cleanup.txt"
    fi
  else
    printf '%s\n' retained-until-disposable-runner-teardown > "$evidence_dir/bootstrap-home-cleanup.txt"
  fi
  printf '%s\n' "$proof_exit" > "$evidence_dir/exit-code.txt"
  exit "$proof_exit"
}
trap finish EXIT

[[ "$RUNNER_ENVIRONMENT" == github-hosted && "$RUNNER_OS" == macOS ]]
[[ "$CI" == true && "$GITHUB_ACTIONS" == true && "$(uname -s)" == Darwin ]]
[[ "$(uname -m)" == arm64 && "$HOME" == "$task_root/home" && "$CFFIXED_USER_HOME" == "$HOME" ]]
[[ "$(git -C "$target_dir" rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ -z "$(git -C "$target_dir" status --porcelain)" ]]
cd "$target_dir"
node - "$evidence_dir/source.json" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const pin = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+sha(?:256|512)\.[a-f0-9]+)?$/.exec(pkg.packageManager);
fs.writeFileSync(process.argv[2], JSON.stringify({
  source: process.env.SOURCE_SHA, lane: process.env.PROOF_LANE,
  mode: process.env.PROOF_MODE, variant: process.env.PROOF_VARIANT,
  node: process.versions.node, architecture: process.arch,
  packageManager: pkg.packageManager, engines: pkg.engines,
}, null, 2) + '\n');
assert.ok(pin, 'Target must declare an exact packageManager');
assert.equal(pin[1], process.env.PNPM_VERSION);
assert.equal(process.versions.node, process.env.NODE_VERSION);
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
NODE
[[ "$(xcodebuild -version)" == $'Xcode 26.6\nBuild version 17F113' ]]
shasum -a 256 scripts/install-xcodegen.sh scripts/prepare-apple-mermaid.mjs \
  package.json pnpm-lock.yaml > "$evidence_dir/bootstrap-inputs.sha256"

phase=dependencies
npm install --global "pnpm@$PNPM_VERSION" > "$evidence_dir/pnpm-install.log" 2>&1
pnpm --version > "$evidence_dir/pnpm-version.log"
[[ "$(cat "$evidence_dir/pnpm-version.log")" == "$PNPM_VERSION" ]]
pnpm install --frozen-lockfile > "$evidence_dir/dependencies.log" 2>&1
[[ -z "$(git status --porcelain)" ]]
phase=apple-tools
tools_dir="$task_root/tools/bin"
bash scripts/install-xcodegen.sh "$tools_dir" > "$evidence_dir/xcodegen-install.log" 2>&1
export PATH="$tools_dir:$PATH"
[[ "$(xcodegen --version)" == 'Version: 2.46.0' ]]
phase=apple-assets
node scripts/prepare-apple-mermaid.mjs > "$evidence_dir/apple-mermaid.log" 2>&1
phase=lane
bash "$lane_dir/run.sh" "$target_dir" "$lane_dir" "$evidence_dir" "$PROOF_MODE"
phase=lane-complete
