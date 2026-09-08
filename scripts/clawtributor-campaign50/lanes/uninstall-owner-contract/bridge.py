"""Wait for the parent to establish OS process containment before starting target code."""
import json
import subprocess
import sys

if len(sys.argv) != 1:
    raise SystemExit('bridge takes its bounded command only on stdin')
request = json.loads(sys.stdin.buffer.readline(65537))
if set(request) != {'argv'} or not isinstance(request['argv'], list):
    raise SystemExit('bad command envelope')
if not request['argv'] or any(not isinstance(arg, str) or '\0' in arg for arg in request['argv']):
    raise SystemExit('bad argv')
# Descendants inherit the parent's process group or assigned Windows Job Object.
child = subprocess.Popen(request['argv'], stdin=subprocess.DEVNULL)
raise SystemExit(child.wait())
