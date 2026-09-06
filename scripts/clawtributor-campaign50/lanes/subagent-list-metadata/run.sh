#!/usr/bin/env bash
set -euo pipefail
proof_target=$1
proof_lane=$2
proof_evidence=$3
proof_mode=$4
case "$proof_mode" in baseline|green) ;; *) exit 2 ;; esac
mkdir -p "$proof_evidence"
cd "$proof_target"
python3 - "$proof_lane/MANIFEST.json" "$proof_mode" <<'PY_BIND'
import hashlib,json,pathlib,subprocess,sys
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text()); mode=sys.argv[2]
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==manifest['source_base']
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+manifest['node']
assert subprocess.check_output(['pnpm','--version'],text=True).strip()=='12.3.4'
assert json.loads(pathlib.Path('package.json').read_text())['packageManager']==manifest['packageManager']
owner=manifest['owner']
expected=owner['baseline_sha256' if mode=='baseline' else 'candidate_sha256']
assert hashlib.sha256(pathlib.Path(owner['path']).read_bytes()).hexdigest()==expected
changed=subprocess.check_output(['git','diff','--no-ext-diff','--name-only','HEAD','--'],text=True).splitlines()
assert changed==([] if mode=='baseline' else [owner['path']]),changed
print('Pinned source, owner bytes, Node and package manager verified before target execution')
PY_BIND
cp "$proof_lane/subagent-list-metadata.proof.mts" src/agents/tools/subagent-list-metadata.proof.mts
proof_state=$(mktemp -d)
trap 'rm -rf -- "$proof_state"' EXIT
proof_driver=(node --import ./scripts/tsx.mjs src/agents/tools/subagent-list-metadata.proof.mts)
for proof_operation in observe benchmark; do
  proof_home="$proof_state/$proof_operation"
  proof_output="$proof_evidence/$proof_operation"
  mkdir -p "$proof_home/home" "$proof_home/xdg/config" "$proof_home/xdg/cache" "$proof_home/xdg/data" "$proof_home/tmp" "$proof_output"
  printf '{}\n' > "$proof_home/openclaw.json"
  env OPENCLAW_STATE_DIR="$proof_home" OPENCLAW_HOME="$proof_home/home" OPENCLAW_CONFIG_PATH="$proof_home/openclaw.json" \
    XDG_CONFIG_HOME="$proof_home/xdg/config" XDG_CACHE_HOME="$proof_home/xdg/cache" XDG_DATA_HOME="$proof_home/xdg/data" TMPDIR="$proof_home/tmp" \
    "${proof_driver[@]}" seed "$proof_home" "$proof_output" > "$proof_output/seed.log" 2>&1
  set +e
  env OPENCLAW_STATE_DIR="$proof_home" OPENCLAW_HOME="$proof_home/home" OPENCLAW_CONFIG_PATH="$proof_home/openclaw.json" \
    XDG_CONFIG_HOME="$proof_home/xdg/config" XDG_CACHE_HOME="$proof_home/xdg/cache" XDG_DATA_HOME="$proof_home/xdg/data" TMPDIR="$proof_home/tmp" \
    "${proof_driver[@]}" "$proof_operation" "$proof_home" "$proof_output" > "$proof_output/run.log" 2>&1
  proof_exit=$?
  set -e
  printf '%s\n' "$proof_exit" > "$proof_output/exit-code.txt"
  if [ "$proof_operation" = benchmark ]; then
    test "$proof_exit" -eq 0
  fi
done
python3 - "$proof_evidence" "$proof_mode" <<'PY'
import json,math,pathlib,re,sys
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]
observed=json.loads((root/'observe/observations.json').read_text())
measured=json.loads((root/'benchmark/measurements.json').read_text())
code=int((root/'observe/exit-code.txt').read_text())
log=(root/'observe/run.log').read_text()
for path in root.glob('*/*.log'):
 text=path.read_text()
 assert not re.search(r'UnhandledPromiseRejection|unhandledRejection|Uncaught Exception|uncaughtException',text),path
assert observed['proof']=='real-subagents-tool-sqlite-metadata' and observed['rowCount']==1000
rows=observed['observations']
assert [row['label'] for row in rows]==['first-list','warm-default-list','empty-controller','after-writer-update']
assert rows[0]['output']==rows[1]['output']
assert rows[0]['output']['status']=='ok' and rows[0]['output']['total']==2
assert [entry['status'] for entry in rows[0]['output']['active']]==['queued','running']
assert rows[0]['output']['active'][0]['totalTokens']==197000
assert rows[0]['output']['active'][1]['totalTokens']==220
assert rows[2]['skills']==rows[2]['reports']==0
assert rows[2]['output']['total']==0 and rows[2]['output']['active']==[]
assert rows[3]['output']['active'][0]['model']=='demo-runtime/updated-model'
assert rows[3]['output']['active'][0]['totalTokens']==198000
assert observed['fullRead']['skills']>0 and observed['fullRead']['reports']>0
nonempty=[row for row in rows if row['label']!='empty-controller']
if mode=='baseline':
 assert code==1 and 'AssertionError' in log and 'SUBAGENT_LIST_DECODED_UNRELATED_PROMPTS' in log
 assert all(row['skills']>=1000 and row['reports']>=1000 for row in nonempty)
 verdict='EXPECTED_UNRELATED_PROMPT_DECODING_CONFIRMED'
else:
 assert code==0
 assert all(row['skills']==row['reports']==0 for row in nonempty)
 verdict='PASS'
assert measured['proof']=='uninstrumented-subagents-tool-sqlite-metadata'
assert measured['rowCount']==1000 and measured['warm']['calls']==25
assert measured['timingThreshold'] is None
for value in [measured['firstSeconds'],measured['warm']['callSeconds'],measured['warm']['wallSeconds']]:
 assert isinstance(value,(int,float)) and math.isfinite(value) and value>=0
for key in ('rssBefore','rssAfterFirst','rssAfterWarm','maxRssKiB'):
 assert isinstance(measured[key],int) and measured[key]>0
result={'mode':mode,'verdict':verdict,'observations':observed,'measurements':measured}
(root/'verdict.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'mode':mode,'verdict':verdict,'decodes':[{key:row[key] for key in ('label','skills','reports')} for row in rows],'measurements':measured}))
PY
sha256sum src/agents/subagents/registry/subagent-list.ts > "$proof_evidence/owner.sha256"
git rev-parse HEAD > "$proof_evidence/source-head.txt"
