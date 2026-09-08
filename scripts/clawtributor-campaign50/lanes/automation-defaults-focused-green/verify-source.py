import hashlib
import json
import pathlib
import subprocess
import sys

target, lane, evidence = map(pathlib.Path, sys.argv[1:4])
phase = sys.argv[4]
assert phase in ('before', 'unit-red', 'candidate', 'after')
manifest = json.loads((lane / 'MANIFEST.json').read_text())
def git(*args):
    return subprocess.check_output(['git', '-C', str(target), *args], text=True).strip()
assert git('rev-parse', 'HEAD') == manifest['source']
expected_changes = [] if phase == 'before' else ['src/config/schema.hints.test.ts'] if phase == 'unit-red' else sorted(manifest['candidateHashes'])
assert sorted(git('diff', '--name-only', 'HEAD', '--').splitlines()) == expected_changes, 'Unexpected tracked source change'
def hashes(root, files):
    result = {}
    for name, expected in files.items():
        actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
        assert actual == expected, f'Hash mismatch: {name}'
        result[name] = actual
    return result
expected = dict(manifest['sourceHashes'])
for name in expected_changes:
    expected[name] = manifest['candidateHashes'][name]
receipt = {'source': manifest['source'], 'phase': phase,
           'manifestSha256': hashlib.sha256((lane / 'MANIFEST.json').read_bytes()).hexdigest(),
           'sourceHashes': hashes(target, expected),
           'packetHashes': hashes(lane, manifest['files'])}
if phase in ('candidate', 'after'):
    receipt['copiedHashes'] = hashes(target, {destination: manifest['files'][source] for source, destination in manifest['copies'].items()})
    generated = target / manifest['generated']
    receipt['generatedSha256'] = hashlib.sha256(generated.read_bytes()).hexdigest()
    assert generated.read_bytes() == (evidence / 'generated-schema.json').read_bytes()
(evidence / f'hashes-{phase}.json').write_text(json.dumps(receipt, indent=2) + '\n')
