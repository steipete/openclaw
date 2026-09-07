"""Check immutable original PTY data; do not rerun source or rewrite the old disposition."""
import hashlib
import json
from pathlib import Path
import re
import sys


def verify(root):
    lineage = json.loads((root / 'REUSE-LINEAGE.json').read_text())
    files = {}
    for name, entry in lineage['files'].items():
        path = root / 'reuse' / name
        assert path.resolve().is_relative_to((root / 'reuse').resolve())
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == entry['sha256'], name
        assert entry['originalRelativePath'] not in files
        files[entry['originalRelativePath']] = raw
    load = lambda name: json.loads(files[name])
    assert lineage['run'] == 34159820010 and lineage['job'] == 101861029380
    assert lineage['harness'] == '8eb7c9aef934a8f8acadc8211e3c9d4d877342b1'
    assert lineage['source'] == '6aa09cbadb594c3d46d5bd49a28c514df1b256b0'
    metadata = load('../run.json')
    assert metadata['databaseId'] == lineage['run'] and metadata['headSha'] == lineage['harness']
    jobs = [j for j in metadata['jobs'] if j['databaseId'] == lineage['job']]
    assert len(jobs) == 1 and jobs[0]['status'] == 'completed' and jobs[0]['conclusion'] == 'success'
    assert hashlib.sha256(files['immutable-harness:PACKET.json']).hexdigest() == lineage['packet']
    before = load('input-before.json')
    assert before == load('input-after.json')
    assert before['packetSha256'] == lineage['packet'] and before['files'] == load('immutable-harness:PACKET.json')['files']
    checks = ''.join(line.split('  ', 1)[1] + ': OK\n' for line in files['immutable-harness:source.sha256'].decode().splitlines()).encode()
    assert len(checks.decode().splitlines()) == 23
    assert files['source-before.log'] == files['source-after.log'] == checks
    for name in ['driver.log', 'check.log', 'final-tracked.patch', 'final-working-tree.patch']:
        assert files[name] == b''
    assert files['exit-code.txt'].strip() == b'0'
    assert files['dependency.log'].decode().startswith('917392e70d646fac367ff99ff3373528196dd56fb8436c373244a7f869277c0e ')
    assert load('source.json')['source'] == lineage['source'] and load('source.json')['node'] == '24.20.0'
    assert load('source.json')['packageManager'].startswith('pnpm@12.3.4+')
    cases = load('immutable-harness:cases.json')
    state = load('processes.json')
    outcomes = load('outcomes.json')
    failed = ['core-32', 'core-36', 'core-6', 'core-delayed-shrink']
    assert load('acceptance.json') == {'accepted': True, 'mode': 'red', 'cases': 9, 'failures': failed}
    assert outcomes['failures'] == failed
    assert state['quiescent'] is True and state['ownedFixtureRemoved'] is True
    assert state['retainedState'] is None and state['cancelledSignal'] is None
    assert len(cases) == len(state['records']) == len(state['inspections']) == 9
    row_counts = [(28, 28), (12, 12), (2, 2), (33, 28), (28, 28), (2, 1), (2, 3), (20, 19), (2, 1)]
    pids = []
    for index, cell in enumerate(cases):
        name = cell['id']
        record = load(name + '/process.json')
        assert record == state['records'][index] and record['id'] == name
        assert all(record[k] is True for k in ['spawned', 'joined', 'eof'])
        assert record['exitCode'] == 0 and record['groupState'] == 'dead' and record['forced'] is False and 'error' not in record
        pids.append(record['pid'])
        raw = files[name + '/raw.ansi']
        assert len(raw) == record['rawBytes'] and hashlib.sha256(raw).hexdigest() == record['rawSha256']
        text = raw.decode('utf8')
        child = load(name + '/child.json')
        label = cell.get('label', 'Checking channel status (probe)…')
        updated = label.replace('Scanning', 'Checking') if 'label' in cell else 'Checking channel status (ready)…'
        assert child['id'] == name and child['label'] == label and child['updatedLabel'] == updated
        assert child['columns'] == cell.get('finalColumns', cell['columns']) and child['initialColumns'] == cell['columns']
        assert child['finalMessage'] == cell.get('finalMessage') and child['suppressed'] is False
        assert all(child[k] is True for k in ['completed', 'listenersRestored', 'rawInputRestored'])
        phases = re.findall(r'\x1b\]777;progress-proof;([^\x07]*)\x07', text)
        assert phases == ['begin'] + (['resize-request'] if cell['kind'] == 'delayed' else []) + ['updated', 'active', 'done', 'settled']
        assert text.endswith('\x1b]777;progress-proof;settled\x07')
        assert re.findall(r'\x1b\]9;4;[\s\S]*?\x1b\\', text) == [f'\x1b]9;4;3;;{label}\x1b\\', f'\x1b]9;4;3;;{updated}\x1b\\', f'\x1b]9;4;0;0;{updated}\x1b\\']
        def plain(value):
            return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', re.sub(r'\x1b\][\s\S]*?(?:\x07|\x1b\\)', '', value))
        pattern = r'\((?:\\/|\|\||--)\)' if cell['kind'] == 'wizard' else r'[◒◐◓◑•oO0]  '
        assert [(a['byte'], a['frames']) for a in record['readySignals']] == [('S', 1), ('A', 26)]
        for ack in record['readySignals']:
            assert len(re.findall(pattern, plain(raw[:ack['offset']].decode('utf8', errors='ignore')))) == ack['frames']
        if cell['kind'] == 'delayed':
            assert record['resizeApplied'] and plain(raw[:record['resizeByteOffset']].decode('utf8')) == ''
        else:
            assert record['resizeApplied'] is False
        inspection = load(name + '/inspection-normal.json')
        assert inspection == state['inspections'][index]
        assert inspection['targetPid'] == record['pid'] and inspection['targetExitCode'] == 0
        assert inspection['canonicalState'] == 'dead' and inspection['exitCode'] == 0 and inspection['forcedSignals'] == [] and 'error' not in inspection
        assert all(inspection[k] is True for k in ['spawned', 'reaped', 'pipeEOF', 'kernelGroupAbsent'])
        pids.append(inspection['observerPid'])
        observation = load(name + '/inspection-normal.stdout')
        assert observation == inspection['observation']
        assert len(files[name + '/inspection-normal.stdout']) == inspection['bytes']['stdout']
        assert len(files[name + '/inspection-normal.stderr']) == inspection['bytes']['stderr'] == 0
        assert observation['pid'] == record['pid'] and observation['observerPid'] == inspection['observerPid'] and observation['exitCode'] == 0
        assert observation['canonicalState'] == 'dead' and observation['policy'] == 'indeterminate' and observation['observationValid'] and observation['builtinBindingsRestored']
        assert observation['observations'] == [{'kind': 'kernel', 'pid': -record['pid'], 'signal': 0, 'error': {'name': 'Error', 'code': 'ESRCH', 'message': 'kill ESRCH'}}]
        screen = load(name + '/screen.json')
        assert screen['done'] == screen['settled']
        counts = tuple(len([line for line in screen[k] if line]) for k in ['active', 'done'])
        assert counts == row_counts[index]
        item = outcomes['results'][index]
        assert item['id'] == name and item['frames'] == 26
        assert (item['activeRows'], item['doneRows']) == counts and item['conforms'] == (name not in failed)
    assert len(set(pids)) == 18
    return {'acceptedOriginalBaseline': True, 'run': lineage['run'], 'job': lineage['job'], 'source': lineage['source'], 'originalNamedViolations': failed, 'originalWizardTinyClassification': 'preservation control', 'observedWizardTinyRows': {'active': 20, 'stopped': 19}, 'baselineRerun': False, 'originalRecordsEdited': False}


if __name__ == '__main__':
    print(json.dumps(verify(Path(__file__).parent), indent=2))
