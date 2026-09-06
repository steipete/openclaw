#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
proof_mode=$4
test "$proof_mode" = red
test "${CI:-}" = 1
test "${PROOF_MODE:-}" = "$proof_mode"
test "${PROOF_LANE:-}" = tui-model-identity-red
test "${SOURCE_SHA:-}" = d613feea804f761d906c4e36b004018c33a634ec
mkdir -p "$proof_evidence"
cd "$proof_target"
python3 - "$proof_lane/MANIFEST.json" "$proof_lane" <<'PY_BIND'
import hashlib,json,pathlib,subprocess,sys
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text()); lane=pathlib.Path(sys.argv[2])
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==manifest['baseSha']
assert subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).strip()==''
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+manifest['node']
assert subprocess.check_output(['pnpm','--version'],text=True).strip()==manifest['pnpm']
package=json.loads(pathlib.Path('package.json').read_text())
assert package['packageManager']==manifest['packageManager']
assert package['devDependencies']['vitest']==manifest['vitest']
for name,expected in manifest['files'].items():
 assert hashlib.sha256((lane/name).read_bytes()).hexdigest()==expected,name
for name,expected in manifest['productionHashes'].items():
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==expected,name
assert hashlib.sha256(pathlib.Path(manifest['testPath']).read_bytes()).hexdigest()==manifest['testBeforeSha256']
print('Exact source, production, test, packet and runtime pins verified')
PY_BIND
retain_evidence() {
  local proof_exit=$?
  trap - EXIT
  git diff --binary > "$proof_evidence/final-working-tree.patch" || proof_exit=2
  git rev-parse HEAD > "$proof_evidence/source-head.txt" || proof_exit=2
  exit "$proof_exit"
}
trap retain_evidence EXIT
git apply --check "$proof_lane/regression.patch"
git apply "$proof_lane/regression.patch"
python3 - "$proof_lane/MANIFEST.json" <<'PY_TEST'
import hashlib,json,pathlib,subprocess,sys
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines()==[manifest['testPath']]
assert hashlib.sha256(pathlib.Path(manifest['testPath']).read_bytes()).hexdigest()==manifest['testAfterSha256']
PY_TEST
printf '%s\n' build > "$proof_evidence/phase.txt"
pnpm build:ci-artifacts > "$proof_evidence/build.log" 2>&1
node openclaw.mjs --version > "$proof_evidence/built-version.txt" 2>&1
printf '%s\n' real-pty > "$proof_evidence/phase.txt"
set +e
env NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1 OPENCLAW_TUI_PTY_USE_BUILT_CLI=1 OPENCLAW_VITEST_MAX_WORKERS=2 \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts src/tui/tui-pty-local.e2e.test.ts \
  --testNamePattern 'launches openclaw (chat as local mode|tui against a real Gateway) through a real PTY' \
  --reporter=verbose --reporter=json --outputFile="$proof_evidence/pty.json" > "$proof_evidence/pty.log" 2>&1
proof_test_exit=$?
set -e
printf '%s\n' "$proof_test_exit" > "$proof_evidence/test-exit.txt"
node "$proof_lane/validate.mjs" "$proof_evidence" "$proof_test_exit"
python3 - "$proof_lane/MANIFEST.json" "$proof_evidence" <<'PY_FINAL'
import hashlib,json,pathlib,subprocess,sys
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text()); evidence=pathlib.Path(sys.argv[2])
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==manifest['baseSha']
assert subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines()==[manifest['testPath']]
observed={name:hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() for name in manifest['productionHashes']}
assert observed==manifest['productionHashes']
assert hashlib.sha256(pathlib.Path(manifest['testPath']).read_bytes()).hexdigest()==manifest['testAfterSha256']
(evidence/'source-bindings.json').write_text(json.dumps({'baseSha':manifest['baseSha'],'productionHashes':observed,'testSha256':manifest['testAfterSha256']},indent=2)+'\n')
PY_FINAL
git diff --check
printf '%s\n' complete > "$proof_evidence/phase.txt"
