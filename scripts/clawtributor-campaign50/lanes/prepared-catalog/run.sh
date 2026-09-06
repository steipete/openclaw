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
  packages/ai/src/transports/anthropic-payload-policy.ts \
  src/agents/embedded-agent-runner/run/runtime-context-prompt.ts \
  src/agents/embedded-agent-runner/run/attempt-session-prepare.ts \
  packages/agent-core/src/harness/messages.ts packages/ai/src/openai-completions-messages.ts > "$evidence_dir/baseline-source.sha256"
retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  exit "$proof_exit"
}
trap retain_diff EXIT
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/gateway-proof.mjs" --repo-root "$target_dir" \
  --artifact-base "$evidence_dir/gateway" --mode red > "$evidence_dir/gateway.log" 2>&1
sha256sum --check "$evidence_dir/baseline-source.sha256"
git diff --check
git diff --exit-code
git diff --cached --exit-code
printf '%s\n' PREPARED_CATALOG_BASELINE_COMPLETE
