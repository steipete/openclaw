"""Verify frozen lane payload bytes before importing any target module."""
import hashlib
import json
from pathlib import Path
import sys

lane = Path(sys.argv[1]).resolve()
receipt = Path(sys.argv[2])
packet_bytes = (lane / "PACKET.json").read_bytes()
packet = json.loads(packet_bytes)
assert packet["files"]
checked = {}
for relative, expected in packet["files"].items():
    path = lane / relative
    assert not Path(relative).is_absolute() and ".." not in Path(relative).parts
    assert path.is_file() and not path.is_symlink()
    assert path.resolve().is_relative_to(lane)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == expected, relative
    checked[relative] = actual
receipt.write_text(json.dumps({"packetSha256": hashlib.sha256(packet_bytes).hexdigest(),
                              "verifiedInputs": checked}, indent=2) + "\n")
