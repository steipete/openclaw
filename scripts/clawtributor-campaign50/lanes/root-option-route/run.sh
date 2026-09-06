#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
[[ "$4" == baseline ]]
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${SOURCE_SHA:?}" == 7475087fa97a73587e2b15ac514733ae3bbfa024 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff --exit-code
sha256sum src/infra/cli-root-options.ts src/cli/program/route-args.ts \
  src/cli/parent-command-path.ts src/cli/gateway-run-argv.ts \
  src/cli/cron-cli/output-mode.ts > "$evidence_dir/baseline-source.sha256"
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/parser-baseline.mjs" \
  "$target_dir" "$evidence_dir" > "$evidence_dir/parser-baseline.log" 2>&1
pnpm build > "$evidence_dir/build.log" 2>&1
node --import "$target_dir/scripts/tsx.mjs" "$lane_dir/baseline-cli.mjs" \
  "$target_dir" "$evidence_dir" > "$evidence_dir/cli-baseline.log" 2>&1
sha256sum --check "$evidence_dir/baseline-source.sha256"
git diff --exit-code
echo ROUTE_OPTION_BASELINE_OK
