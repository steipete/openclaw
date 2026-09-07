"""Exercise the authored report reader with synthetic data only."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).parent
core = [f'cli progress bounds spinner at {c} columns' for c in [32, 36, 80]] + ['cli progress suppresses animation below the frame budget', 'cli progress does not let a finished reporter clear or unlock a newer progress line', 'cli progress unregisters a delayed tty progress line when done before start']
wizard = ['createClackPrompter keeps completion after clearing tiny animation', 'createClackPrompter preserves tiny completion undefined once', 'createClackPrompter preserves tiny completion "" once', 'createClackPrompter preserves tiny completion "First line\\nSecond line" once']
core += [f'core-control-{i}' for i in range(15 - len(core))]
wizard += [f'wizard-control-{i}' for i in range(35 - len(wizard))]
case = lambda title: {'fullName': title, 'title': title, 'status': 'passed', 'failureMessages': []}
report = {'success': True, 'numTotalTests': 50, 'numPassedTests': 50, 'numFailedTests': 0, 'numPendingTests': 0, 'numTodoTests': 0, 'testResults': [
    {'name': '/fixture/src/cli/progress.test.ts', 'status': 'passed', 'message': '', 'assertionResults': [case(t) for t in core]},
    {'name': '/fixture/src/wizard/clack-prompter.test.ts', 'status': 'passed', 'message': '', 'assertionResults': [case(t) for t in wizard]},
]}
log = ' Test Files  2 passed (2)\n      Tests  50 passed (50)\n   Duration  1.00s (tests 1.00s)\n'
checks = []
with tempfile.TemporaryDirectory(prefix='progress-reader-inert-') as tmp:
    tmp = Path(tmp)
    for name in ['valid', 'global-error', 'unfinished-report', 'missing-duration', 'missing-tiny-case', 'pending-test', 'failed-test', 'wrong-file', 'retry-after-timeout', 'fatal-oom']:
        sample = copy.deepcopy(report)
        sample_log = log
        if name == 'global-error': sample_log += 'Unhandled Error: inert guard\n'
        if name == 'unfinished-report': sample_log += 'JSON report was generated while some tests are still running\n'
        if name == 'missing-duration': sample_log = '\n'.join(log.splitlines()[:2]) + '\n'
        if name == 'missing-tiny-case': sample['testResults'][1]['assertionResults'][1]['fullName'] = 'missing'
        if name == 'pending-test': sample['numPendingTests'] = 1
        if name == 'failed-test': sample['testResults'][0]['assertionResults'][0]['status'] = 'failed'
        if name == 'retry-after-timeout': sample_log += '[test] retrying 1 test file after no-output timeout\n'
        if name == 'fatal-oom': sample_log += 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'
        if name == 'wrong-file': sample['testResults'][1]['name'] = '/fixture/wrong.test.ts'
        (tmp/'report.json').write_text(json.dumps(sample))
        (tmp/'report.log').write_text(sample_log)
        completed = subprocess.run(['node', str(root/'validate-tests.mjs'), str(tmp/'report.json'), str(tmp/'report.log'), '0'], capture_output=True, text=True)
        assert (completed.returncode == 0) == (name == 'valid'), (name, completed.stderr)
        checks.append({'case': name, 'accepted': completed.returncode == 0})
print(json.dumps({'targetExecution': False, 'checks': checks}, indent=2))
