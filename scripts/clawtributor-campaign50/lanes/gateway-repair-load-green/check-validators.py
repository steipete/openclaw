"""Data-only guards for authored validators; never imports or runs OpenClaw."""
import copy
import hashlib
import json
import pathlib
import subprocess
import tempfile

lane = pathlib.Path(__file__).parent
campaign = lane.parents[1]
baseline = campaign / 'proof-infra/runs/34094232133/campaign50-gateway-repair-load-red-1/evidence/gateway-repair-load-red'
observed = json.loads((baseline / 'behavior.json').read_text())
results = []

def record(name, command, accepted):
    result = subprocess.run(command, capture_output=True, text=True)
    assert (result.returncode == 0) is accepted, (name, result.returncode, result.stderr[-1200:])
    results.append({'name': name, 'expectedAcceptance': accepted, 'passed': True})

def behavior_check(name, mutate=None, accepted=False):
    with tempfile.TemporaryDirectory(prefix='campaign139145-validator-') as temp:
        root = pathlib.Path(temp)
        data = copy.deepcopy(observed)
        for case in data['cases']:
            case['contractViolated'] = False
            dest = root / case['id']
            dest.mkdir()
            for file in ['cleanup.json', 'seed-install.process.json', 'action.process.json', 'manager-errors.json', 'native-calls.json']:
                (dest/file).write_bytes((baseline/case['id']/file).read_bytes())
            if case['fault'] != 'healthy':
                detail = 'Permission denied: campaign post-install inspection' if case['fault'] == 'throw' else 'Gateway service is not loaded after repair.'
                case['cli'] = {'code': 1, 'value': {'action': case['action'], 'ok': False, 'error': 'Gateway repair failed: Error: '+detail}}
                process = json.loads((dest/'action.process.json').read_text())
                process['code'] = 1
                (dest/'action.process.json').write_text(json.dumps(process))
            (dest/'action.stdout').write_text(json.dumps(case['cli']['value']))
        (root/'driver.log').write_text('POST_INSTALL_VERIFICATION_CONTRACT_PASSED\n')
        if mutate:
            mutate(data, root)
        (root/'behavior.json').write_text(json.dumps(data))
        record(name, ['python3', str(lane/'validate.py'), str(root), '0'], accepted)

def change_json(root, relative, modify):
    file = root / relative
    data = json.loads(file.read_text())
    modify(data)
    file.write_text(json.dumps(data))

behavior_check('six synthetic candidate outcomes accepted', accepted=True)
behavior_check('reported semantic violation rejected', lambda data, root: data['cases'][0].update(contractViolated=True))
behavior_check('missing case rejected', lambda data, root: data['cases'].pop())
behavior_check('false success rejected', lambda data, root: data['cases'][0]['cli'].update(code=0))
behavior_check('unhealthy Gateway rejected', lambda data, root: data['cases'][0].update(readiness=[200, 503]))
behavior_check('unjoined Gateway rejected', lambda data, root: change_json(root, 'start-throw/cleanup.json', lambda item: item.update(gatewayJoined=False, retainedState=True)))
behavior_check('timed out CLI rejected', lambda data, root: change_json(root, 'start-throw/action.process.json', lambda item: item.update(timedOut=True)))
behavior_check('wrong raw JSON rejected', lambda data, root: (root/'start-throw/action.stdout').write_text('{}'))
behavior_check('new success projection on error rejected', lambda data, root: data['cases'][0]['cli']['value'].update(service={'loaded': True}))
behavior_check('missing native post-install probes rejected', lambda data, root: (root/'start-throw/native-calls.json').write_text('[]'))

names = [f'repairLoadedGatewayServiceForStart fails {action} repair when the post-install probe {probe}' for action in ['start', 'restart'] for probe in ['throws', 'returns false']]
def report_check(name, mode, mutate=None, accepted=False):
    with tempfile.TemporaryDirectory(prefix='campaign139145-report-') as temp:
        root = pathlib.Path(temp)
        red = mode == 'red'
        tests = [{'title': f'existing owner control {n}', 'fullName': f'existing owner control {n}', 'status': 'passed', 'failureMessages': []} for n in range(15)]
        tests += [{'title': full, 'fullName': full, 'status': 'failed' if red else 'passed', 'failureMessages': ['AssertionError: promise resolved "{ loaded: true }" instead of rejecting'] if red else []} for full in names]
        suites = [{'name': '/synthetic/src/cli/daemon-cli/start-repair.test.ts', 'status': 'failed' if red else 'passed', 'message': '', 'assertionResults': tests}]
        if not red:
            for n, title in enumerate(['restarts a disabled installed service through its native manager', 'fails restart when an installed service cannot be inspected', 'real readiness control', 'install failure control']):
                suites.append({'name': f'/synthetic/sibling{n}.test.ts', 'status': 'passed', 'message': '', 'assertionResults': [{'title': title, 'fullName': title, 'status': 'passed', 'failureMessages': []}]})
        report = {'testResults': suites, 'numTotalTests': 19 if red else 23, 'numPassedTests': 15 if red else 23, 'numFailedTests': 4 if red else 0, 'numPendingTests': 0, 'numTodoTests': 0, 'success': not red}
        log = 'Test Files 1 failed (1)\nTests 4 failed | 15 passed (19)\nDuration 1s (tests 1s)\n' if red else 'Test Files 5 passed (5)\nTests 23 passed (23)\nDuration 1s (tests 1s)\n'
        if mutate:
            report, log = mutate(report, log)
        (root/'report.json').write_text(json.dumps(report))
        (root/'report.log').write_text(log)
        record(name, ['node', str(lane/'validate-tests.mjs'), str(root/'report.json'), str(root/'report.log'), mode, '1' if red else '0'], accepted)

report_check('four exact synthetic unit reds accepted', 'red', accepted=True)
report_check('five complete synthetic green suites accepted', 'green', accepted=True)
report_check('Vitest still-running warning rejected', 'green', lambda r, log: (r, log+'WARNING: Some tests are still running when generating the JSON report.'))
report_check('global unhandled error rejected', 'green', lambda r, log: (r, log+'Unhandled Errors\n'))
report_check('missing completed summary rejected', 'green', lambda r, log: (r, 'no completed summary'))
def alter_test(report, log, field, value):
    report['testResults'][0]['assertionResults'][-1][field] = value
    return report, log
report_check('wrong red exception rejected', 'red', lambda r, log: alter_test(r, log, 'failureMessages', ['Hook timed out']))
report_check('pending green test rejected', 'green', lambda r, log: alter_test(r, log, 'status', 'pending'))
report_check('missing exact regression title rejected', 'red', lambda r, log: alter_test(r, log, 'fullName', 'unrelated failure'))
report_check('errored suite rejected', 'green', lambda r, log: (dict(r, testResults=[dict(r['testResults'][0], message='setup failed'), *r['testResults'][1:]]), log))
receipt = {'scope': 'inert JSON/log/process-receipt fixtures only; no OpenClaw code or runtime execution', 'validators': {name: hashlib.sha256((lane/name).read_bytes()).hexdigest() for name in ['validate.py', 'validate-tests.mjs', 'completed-report.mjs']}, 'checks': results}
(lane/'VALIDATOR-CHECKS.json').write_text(json.dumps(receipt, indent=2)+'\n')
print(json.dumps({'passed': len(results), 'targetExecution': False}))
