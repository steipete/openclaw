"""Data-only gate before any proof driver or installer import."""
import hashlib
import json
from pathlib import Path
import sys
lane, target, output = map(lambda value: Path(value).resolve(), sys.argv[1:])
packet = json.loads((lane/'PACKET.json').read_text())
if packet['stage'] != 'frozen-executable-candidate' or packet['source'] != 'f5a30f8484671abdb422a9ea8b39837a668ed019':
    raise SystemExit('executable packet is not frozen for this source')
records=[]
for item in packet['files']:
    relative=Path(item['path'])
    if relative.is_absolute() or '..' in relative.parts:
        raise SystemExit('unsafe packet input path')
    path=lane/relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(lane):
        raise SystemExit('missing/nonregular packet input')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if digest!=item['sha256']:
        raise SystemExit('input changed: '+item['path'])
    records.append({'path':item['path'],'sha256':digest})
for item in packet['targetSources']:
    relative=Path(item['path'])
    if relative.is_absolute() or '..' in relative.parts:raise SystemExit('unsafe source path')
    path=target/relative
    if not path.resolve().is_relative_to(target):raise SystemExit('source escapes target')
    if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
        raise SystemExit('target source mismatch: '+item['path'])
output.write_text(json.dumps({'packetSha256':hashlib.sha256((lane/'PACKET.json').read_bytes()).hexdigest(),
                              'source':packet['source'],'inputs':records,'targetSources':packet['targetSources']},indent=2)+'\n')
