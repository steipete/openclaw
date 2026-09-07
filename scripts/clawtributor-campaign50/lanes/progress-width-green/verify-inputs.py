import hashlib
import json
from pathlib import Path
import sys
lane, receipt = map(Path, sys.argv[1:])
packet = json.loads((lane / 'PACKET.json').read_text())
observed = {}
for name, expected in packet['files'].items():
    path = lane / name
    assert path.is_file() and path.resolve().is_relative_to(lane.resolve())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == expected, name
    observed[name] = digest
receipt.write_text(json.dumps({'packetSha256': hashlib.sha256((lane / 'PACKET.json').read_bytes()).hexdigest(), 'files': observed}, indent=2) + '\n')
