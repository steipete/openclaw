import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile

lane = pathlib.Path(__file__).parent
subprocess.run(['node', str(lane / 'validate-reuse69.mjs'), str(lane)], check=True, stdout=subprocess.DEVNULL)
results = []
for name, file, change in [
    ('original run relabeled green', 'reuse-69/run.json', lambda data: data.update(conclusion='success')),
    ('candidate source changed', 'MANIFEST.json', lambda data: data['candidateHashes'].update({'src/config/schema.hints.ts': '0' * 64})),
    ('unit green case missing', 'reuse-69/unit-green.json', lambda data: data['testResults'][0]['assertionResults'].pop()),
    ('browser case skipped', 'reuse-69/vitest.json', lambda data: data.update(numPendingTests=1)),
    ('roundtrip action missing', 'reuse-69/cases/roundtrip.json', lambda data: data['stages'][6]['snapshot']['callbacks'].pop()),
    ('capture outside viewport', 'reuse-69/cases/roundtrip.json', lambda data: data['captures'][0]['bounds'].update(y=-1)),
]:
    with tempfile.TemporaryDirectory(prefix='config-runtime-reuse-') as directory:
        copy = pathlib.Path(directory) / 'packet'
        shutil.copytree(lane, copy)
        target = copy / file
        data = json.loads(target.read_text())
        change(data)
        target.write_text(json.dumps(data))
        manifest_file = copy / 'MANIFEST.json'
        manifest = json.loads(manifest_file.read_text())
        carrier = manifest['reusedCandidate']['carriers'].get(file)
        if carrier:
            carrier['sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
            manifest_file.write_text(json.dumps(manifest))
        result = subprocess.run(['node', str(copy / 'validate-reuse69.mjs'), str(copy)], capture_output=True)
        assert result.returncode != 0, f'Accepted invalid reused outcome: {name}'
        assert b'AssertionError' in result.stderr, f'Unexpected reader setup failure: {name}'
        results.append({'name': name, 'rejected': True})
print(json.dumps({'scope': 'cached-data controls only; no target execution', 'positive': 1, 'negative': results}, indent=2))
