#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${CI:-}" == 1 ]]
[[ "${PROOF_MODE:-}" == "$mode" ]]
[[ "${PROOF_LANE:-}" == "prepared-catalog-$mode" ]]
[[ "$mode" == red ]]
[[ "${SOURCE_SHA:?}" == 3967d9b6df1f478c32b0c4127bbadf5c51f1878f ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff --exit-code
git diff --cached --exit-code
sha256sum src/auto-reply/reply/agent-runner-memory.ts src/auto-reply/reply/memory-flush.ts \
  src/auto-reply/reply/model-selection-context.ts src/auto-reply/reply/get-reply-run-admission.ts \
  src/agents/context.ts src/agents/context-resolution.ts src/agents/model-catalog-lookup.ts \
  src/gateway/server-startup-context-cache-prewarm.ts extensions/qa-lab/src/gateway-child-env.ts \
  extensions/deepseek/openclaw.plugin.json extensions/memory-core/src/flush-plan.ts \
  packages/ai/src/transports/openai-responses-payload-policy.ts \
  packages/ai/src/transports/anthropic-payload-policy.ts > "$evidence_dir/baseline-source.sha256"
retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  exit "$proof_exit"
}
trap retain_diff EXIT
printf '%s  %s\n' d83794254578ab2a1c7b19292908de395107c093a028e42b85f603f569bc8494 "$lane_dir/baseline-tests.patch" | sha256sum --check
printf '%s  %s\n' 4f88efd1d9098436edddc510c38563c84966df43f01e47ec4af947ecd2e4d86e src/auto-reply/reply/agent-runner-memory.test.ts | sha256sum --check
git apply --check "$lane_dir/baseline-tests.patch"
git apply "$lane_dir/baseline-tests.patch"
printf '%s  %s\n' 4369daf07aafb678989bf703bb50458ed2ec2fdd6d47631fb5cab39d7a0716cc src/auto-reply/reply/agent-runner-memory.test.ts | sha256sum --check
set +e
node scripts/run-vitest.mjs run src/auto-reply/reply/agent-runner-memory.test.ts \
  -t 'catalog facts for maintenance decisions' --reporter=verbose --reporter=json \
  --outputFile="$evidence_dir/unit.json" > "$evidence_dir/unit.log" 2>&1
test_exit=$?
set -e
node "$lane_dir/validate-tests.mjs" "$evidence_dir/unit.json" "$evidence_dir/unit.log" red "$test_exit"
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/gateway-proof.mjs" --repo-root "$target_dir" \
  --artifact-base "$evidence_dir/gateway" --mode red > "$evidence_dir/gateway.log" 2>&1
sha256sum --check "$evidence_dir/baseline-source.sha256"
printf '%s  %s\n' 4369daf07aafb678989bf703bb50458ed2ec2fdd6d47631fb5cab39d7a0716cc src/auto-reply/reply/agent-runner-memory.test.ts | sha256sum --check
git diff --check
[[ "$(git diff --name-only)" == src/auto-reply/reply/agent-runner-memory.test.ts ]]
printf '%s\n' PREPARED_CATALOG_BASELINE_COMPLETE
