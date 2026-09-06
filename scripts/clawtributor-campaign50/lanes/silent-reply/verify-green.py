import json
import pathlib
import re
import sys

report_path, log_path, exit_text, source = sys.argv[1:]
report = json.loads(pathlib.Path(report_path).read_text())
log = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", pathlib.Path(log_path).read_text())
assert int(exit_text) == 0 and report['success'] is True
assert all(re.search(r"(?m)^\s*" + label + r"\s", log) for label in ["Test Files", "Tests", "Start at", "Duration"]), "No completed Vitest summary"
assert not re.search(r"Vitest caught \d+ unhandled error|Unhandled Errors|Unhandled Rejection|Uncaught Exception|EnvironmentTeardownError|Failed Suites|Some tests are still running when generating the JSON report", log), "Runtime or hook failure"
suites = report['testResults']
assert len(suites) == 1 and not suites[0].get('message')
assert suites[0]['name'].replace('\\', '/').endswith(source)
checks = suites[0]['assertionResults']
assert checks and all(a['status'] == 'passed' and not a.get('failureMessages') for a in checks)
assert report['numFailedTests'] == 0 and report['numPassedTests'] == len(checks)
if source.endswith('silent-reply-prompt-mode.e2e.test.ts'):
    assert len(checks) == 1
    assert checks[0]['title'] == 'omits generic silence guidance in the actual provider request while replying normally'
pathlib.Path(report_path).with_suffix('.verdict.json').write_text(json.dumps({'source': source, 'verdict': 'PASS', 'tests': len(checks)}, indent=2) + '\n')
print(f'{source}: {len(checks)} passed')
