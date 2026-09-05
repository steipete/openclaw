#!/usr/bin/env bash
set -euo pipefail
lane="$1"
proof_dir="$2/channels"
evidence_dir="$3"
mkdir -p "$evidence_dir"
cp "$proof_dir/run-channel-proof.sh" .clawtributor-channel-run.sh
if [[ "$lane" == buzz ]]; then
  cp "$proof_dir/buzz-transport-proof.ts" buzz-transport-proof.ts
  owner=extensions/buzz/src/channel.ts
  tests=(extensions/buzz/src/channel.test.ts extensions/buzz/src/inbound.test.ts extensions/buzz/src/buzz-bus.test.ts)
else
  cp "$proof_dir/feishu-runtime-proof.ts" feishu-runtime-proof.ts
  cp "$proof_dir/feishu-debounce-runtime-proof.ts" feishu-debounce-runtime-proof.ts
  owner=extensions/feishu/src/bot-content.ts
  tests=(extensions/feishu/src/bot.stripBotMention.test.ts extensions/feishu/src/bot.checkBotMentioned.test.ts)
fi
git rev-parse HEAD > "$evidence_dir/baseline-sha.txt"
cp "$owner" "$evidence_dir/owner-baseline.ts"
bash .clawtributor-channel-run.sh "$lane" red "$evidence_dir/baseline.log"
if [[ "$lane" == feishu ]]; then
  node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'extensions/feishu/src/bot-content.ts';
const source = readFileSync(file, 'utf8');
const old = 'for (const mention of mentions) {';
assert.equal(source.split(old).length, 2);
writeFileSync(file, source.replace(old, 'for (const mention of [...mentions].sort((a, b) => b.key.length - a.key.length)) {'));
JS
  bash .clawtributor-channel-run.sh feishu red "$evidence_dir/sorted-only.log"
  grep -Fq 'Error: FEISHU_MENTION_REGRESSION:literal-name-group' "$evidence_dir/sorted-only.log"
  cp "$evidence_dir/owner-baseline.ts" "$owner"
fi
git apply --check "$proof_dir/$lane-canonical.patch"
git apply "$proof_dir/$lane-canonical.patch"
if [[ "$lane" == buzz ]]; then
  git apply "$proof_dir/buzz-hook-tests.patch"
else
  git apply "$proof_dir/feishu-parser-tests.patch"
fi
git diff --check
if [[ "$lane" == feishu ]]; then
  bash .clawtributor-channel-run.sh feishu green "$evidence_dir/normalizer-only.log"
  bash .clawtributor-channel-run.sh feishu-debounce red "$evidence_dir/debounce-baseline.log"
  git apply --check "$proof_dir/feishu-debounce-owner.patch"
  git apply "$proof_dir/feishu-debounce-owner.patch"
  git apply "$proof_dir/feishu-debounce-tests.patch"
  git diff --check
  bash .clawtributor-channel-run.sh feishu-debounce green "$evidence_dir/debounce-candidate.log"
  tests+=(extensions/feishu/src/monitor.reaction.test.ts extensions/feishu/src/monitor.message-handler.debounce-policy.test.ts extensions/feishu/src/sequential-key.test.ts extensions/feishu/src/bot.test.ts)
fi
git diff > "$evidence_dir/candidate.patch"
bash .clawtributor-channel-run.sh "$lane" green "$evidence_dir/candidate.log"
node scripts/run-vitest.mjs "${tests[@]}" 2>&1 | tee "$evidence_dir/candidate-tests.log"
sha256sum "$owner" > "$evidence_dir/candidate-sha256.txt"
