import ast
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).parent
source = (root / 'driver.py').read_text()
functions = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name in {'frame_count', 'cancel'}]
assert len(functions) == 2
scope = {'re': re, 'cleaning': False, 'cancelled_signal': None}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<owned-inert-functions>', 'exec'), scope)
count = scope['frame_count']
checks = []
for kind, raw, expected in [
    ('wizard', b'(||)  ', 1),
    ('wizard', b'(||)\n  ', 1),
    ('wizard', b'\x1b[38;2;255;0;0m(-- )\x1b[0m', 0),
    ('wizard', b'\x1b[38;2;255;0;0m(--)\x1b[0m\n  ', 1),
    ('wizard', b'\x1b]9;4;3;;(||)\x1b\\', 0),
    ('core', '◒  Checking'.encode(), 1),
    ('core', b'\x1b]777;progress-proof;updated\x07', 0),
]:
    assert count(raw, kind) == expected
    checks.append({'kind': kind, 'inputSha256': hashlib.sha256(raw).hexdigest(), 'count': expected})
try:
    scope['cancel'](15, None)
    raise AssertionError('first cancellation did not interrupt')
except InterruptedError:
    pass
assert scope['cancelled_signal'] == 15
scope['cleaning'] = True
scope['cancel'](1, None)
scope['cancel'](2, None)
assert scope['cancelled_signal'] == 15
checks.append({'cancellation': 'first signal interrupts; repeated signals during cleanup are latched without interruption'})
print(json.dumps({'driverSha256': hashlib.sha256(source.encode()).hexdigest(), 'targetImports': False, 'targetExecution': False, 'checks': checks}, indent=2))
