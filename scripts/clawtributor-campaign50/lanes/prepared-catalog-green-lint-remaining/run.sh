#!/usr/bin/env bash
set -euo pipefail
target_dir=$1
lane_dir=$2
evidence_dir=$3
mode=$4
cd "$target_dir"
mkdir -p "$evidence_dir"
[[ "${CI:-}" == 1 ]]
[[ "$mode" == green ]]
[[ "${PROOF_MODE:-}" == green ]]
[[ "${PROOF_LANE:-}" == prepared-catalog-green-lint-remaining ]]
[[ "${SOURCE_SHA:?}" == f63095668169ea0260f5f7b6479dafc85cc5226c ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(node --version)" == v24.20.0 ]]
[[ "$(pnpm --version)" == 12.3.4 ]]
git diff --exit-code
git diff --cached --exit-code
sha256sum src/auto-reply/reply/model-selection-context.ts src/auto-reply/reply/get-reply-run-admission.ts \
  src/agents/context.ts src/agents/context-resolution.ts src/agents/model-catalog-lookup.ts \
  src/gateway/server-startup-context-cache-prewarm.ts extensions/qa-lab/src/gateway-child-env.ts \
  extensions/deepseek/openclaw.plugin.json extensions/memory-core/src/flush-plan.ts \
  packages/ai/src/transports/openai-responses-payload-policy.ts packages/ai/src/transports/anthropic-payload-policy.ts \
  src/agents/embedded-agent-runner/run/runtime-context-prompt.ts \
  src/agents/embedded-agent-runner/run/attempt-session-prepare.ts src/agents/embedded-agent-runner/run/attempt-prompt-build.ts \
  src/agents/embedded-agent-runner/run/attempt-llm-boundary.ts src/gateway/server-methods/agent-timestamp.ts \
  packages/agent-core/src/harness/messages.ts packages/ai/src/openai-completions-messages.ts \
  src/agents/session-maintenance/run.ts src/agents/session-maintenance/coordinator.ts \
  src/auto-reply/reply/agent-runner-maintenance.ts src/auto-reply/reply/memory-flush-session.ts \
  src/auto-reply/reply/agent-runner-execute.ts src/logging/json-console-line.ts \
  scripts/lib/vitest-report-owner.mts scripts/lib/vitest-report-capture.mts > "$evidence_dir/unchanged-source.sha256"
retain_diff() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$evidence_dir/final-working-tree.patch" || proof_exit=2
  exit "$proof_exit"
}
trap retain_diff EXIT
printf '%s  %s\n' 59e4b55a0ef1ed1e76a491717f4d6de4a6f76571f142f8918939a230e16e81e3 "$lane_dir/reuse/LINEAGE.json" | sha256sum --check
node "$lane_dir/validate-reuse.mjs" "$lane_dir" "$evidence_dir"
sha256sum --check "$lane_dir/reuse/unchanged-source.sha256"
printf '%s  %s\n' 7726f960b6322334c2c5578951fc7a0851b306606b17b603b8bc82d0fd2dfb9d "$lane_dir/reuse-checks/LINEAGE.json" | sha256sum --check
sha256sum --check "$lane_dir/reuse-checks/unchanged-source.sha256"
printf '%s  %s\n' 1a42e4917dfda234bd3a4e32dfcd365a06baf4cf3271497fbda544fcc6f3704b "$lane_dir/candidate-before.patch" | sha256sum --check
git apply --check "$lane_dir/candidate-before.patch"
git apply "$lane_dir/candidate-before.patch"
sha256sum --check "$lane_dir/candidate-before-source.sha256"
git apply --reverse --check "$lane_dir/reuse/final-working-tree.patch"
git apply --reverse --check "$lane_dir/reuse-checks/final-working-tree.patch"
printf '%s  %s\n' e922e214813934dca1467b052828bbcff18130ff61752f99ba6780950c408b30 "$lane_dir/candidate.patch" | sha256sum --check
printf '%s  %s\n' e73a631c7aeee14bba02d92d61d54b65ef808074f4be23d280976367117c9b94 "$lane_dir/alpha-rename.patch" | sha256sum --check
git apply --check "$lane_dir/alpha-rename.patch"
git apply "$lane_dir/alpha-rename.patch"
sha256sum --check "$lane_dir/candidate-source.sha256"
node "$lane_dir/validate-checks-and-rename.mjs" "$lane_dir" "$target_dir" "$evidence_dir"
node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.core.json \
  src/agents/context.opencode-go.test.ts src/auto-reply/reply/agent-runner-memory.test.ts \
  src/auto-reply/reply/agent-runner-memory.ts src/auto-reply/reply/memory-flush.test.ts \
  src/auto-reply/reply/memory-flush.ts src/auto-reply/reply/reply-state.test.ts > "$evidence_dir/lint.log" 2>&1
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build > "$evidence_dir/build.log" 2>&1
node "$lane_dir/gateway-proof.mjs" --repo-root "$target_dir" --artifact-base "$evidence_dir/gateway" --mode green > "$evidence_dir/gateway.log" 2>&1
sha256sum --check "$lane_dir/candidate-source.sha256"
sha256sum --check "$evidence_dir/unchanged-source.sha256"
git diff --check
git diff --name-only | sort > "$evidence_dir/changed-files.txt"
cut -d ' ' -f 3 "$lane_dir/candidate-source.sha256" | sort > "$evidence_dir/expected-files.txt"
cmp "$evidence_dir/changed-files.txt" "$evidence_dir/expected-files.txt"
printf '%s\n' PREPARED_CATALOG_REMAINING_GREEN_COMPLETE
