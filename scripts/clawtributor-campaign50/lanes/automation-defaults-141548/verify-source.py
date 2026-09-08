import hashlib
import json
import pathlib
import subprocess
import sys

target, lane, evidence = map(pathlib.Path, sys.argv[1:4])
phase = sys.argv[4]
assert phase in ('before', 'after')
manifest = json.loads((lane / 'MANIFEST.json').read_text())
def git(*args):
    return subprocess.check_output(['git', '-C', str(target), *args], text=True).strip()
assert git('rev-parse', 'HEAD') == manifest['source']
assert git('diff', '--name-only', 'HEAD', '--') == '', 'Tracked source changed'
def hashes(root, files):
    result = {}
    for name, expected in files.items():
        actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
        assert actual == expected, f'Hash mismatch: {name}'
        result[name] = actual
    return result
receipt = {'source': manifest['source'], 'phase': phase,
           'manifestSha256': hashlib.sha256((lane / 'MANIFEST.json').read_bytes()).hexdigest(),
           'sourceHashes': hashes(target, manifest['sourceHashes']),
           'packetHashes': hashes(lane, manifest['files'])}
if phase == 'after':
    receipt['copiedHashes'] = hashes(target, {destination: manifest['files'][source] for source, destination in manifest['copies'].items()})
    generated = target / manifest['generated']
    receipt['generatedSha256'] = hashlib.sha256(generated.read_bytes()).hexdigest()
    assert generated.read_bytes() == (evidence / 'generated-schema.json').read_bytes()
(evidence / f'hashes-{phase}.json').write_text(json.dumps(receipt, indent=2) + '\n')
