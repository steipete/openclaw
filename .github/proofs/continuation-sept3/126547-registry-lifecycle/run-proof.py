"""Source-bound full-build lifecycle/restart/generation proof; activation and baseline acceptance are explicit gates."""
from pathlib import Path
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback

os.umask(0o077)
assets = Path(__file__).resolve().parent
checkout, evidence, started_file = [Path(value).resolve() for value in sys.argv[1:4]]
lane = sys.argv[4]
assert lane in {'baseline', 'candidate'}
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
packet = json.loads((assets / 'execution-binding.json').read_text())
binding = {**packet, **packet['lanes'][lane]}
proof_root = assets.parents[3]
receipt = {'schema': 'openclaw-126547-registry-lifecycle-v1', 'passed': False,
           'diagnosticComplete': False, 'phase': 'setup', 'lane': lane,
           'comparison': packet['comparison'], 'commands': [], 'groups': [],
           'unconfirmedCommandGroups': [], 'cleanupErrors': []}
TEST_PATH = 'src/gateway/server-plugins.lifecycle.test.ts'
RESTART_PATH = 'src/gateway/server-reload-channel-restart.test.ts'
GENERATION_PATH = 'src/gateway/server-plugin-runtime-generation.test.ts'
TEST_PATHS = [TEST_PATH, RESTART_PATH, GENERATION_PATH]
scratch = node = installed_lock = initial_guard = None
manifest = manifest_bytes = None
MAX_LOG_BYTES = 16 * 1024 * 1024
index_observations = []
index_capture_bytes = {}
deadline = None


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(file):
    return sha(Path(file).read_bytes())


def save(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def retain_index(file):
    # Index files contain public tracked paths and stat metadata, never Git config.
    assert not file.is_symlink() and file.is_file()
    with file.open('rb') as source:
        metadata = os.fstat(source.fileno())
        assert metadata.st_size <= 8 * 1024 * 1024, 'Index diagnostic exceeds bound'
        data = source.read(8 * 1024 * 1024 + 1)
    assert len(data) == metadata.st_size and data[:4] == b'DIRC'
    identity = sha(data)
    directory = evidence / 'index-diagnostics'
    directory.mkdir(exist_ok=True)
    assert not directory.is_symlink()
    if identity not in index_capture_bytes:
        assert sum(index_capture_bytes.values()) + len(data) <= 24 * 1024 * 1024
        (directory / (identity + '.index')).write_bytes(data)
        index_capture_bytes[identity] = len(data)
    return {'sha256': identity, 'bytes': len(data), 'mtimeNs': metadata.st_mtime_ns,
            'ctimeNs': metadata.st_ctime_ns, 'inode': metadata.st_ino,
            'observedAtUnixNs': time.time_ns()}


def git(*args, cwd=checkout):
    argv = ['/usr/bin/git', '-c', 'core.fsmonitor=false', *args]
    env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
    if cwd != checkout:
        return subprocess.check_output(argv, cwd=cwd, env=env)
    index = checkout / '.git/index'
    assert (checkout / '.git').is_dir() and not (checkout / '.git').is_symlink()
    observation = {'argv': argv, 'before': retain_index(index)}
    assert len(index_observations) < 512
    try:
        if args[0] == 'diff':
            # Porcelain diff may refresh stat metadata despite optional-locks=0.
            # Keep its content comparison intact while it owns only a disposable copy.
            with tempfile.TemporaryDirectory(prefix='diff-index-', dir=evidence) as temporary:
                comparison = Path(temporary) / 'index'
                comparison.write_bytes((evidence / 'index-diagnostics' / (observation['before']['sha256'] + '.index')).read_bytes())
                # Git uses index mtime for its racy-stat test; preserve that input too.
                os.utime(comparison, ns=(observation['before']['mtimeNs'], observation['before']['mtimeNs']))
                observation['comparisonBefore'] = retain_index(comparison)
                try:
                    return subprocess.check_output(argv, cwd=cwd, env={**env, 'GIT_INDEX_FILE': str(comparison)})
                finally:
                    observation['comparisonAfter'] = retain_index(comparison)
        return subprocess.check_output(argv, cwd=cwd, env=env)
    finally:
        observation['after'] = retain_index(index)
        index_observations.append(observation)
        save(evidence / 'index-command-observations.json', index_observations)
        assert observation['before']['sha256'] == observation['after']['sha256'], 'Read-only Git command changed real index'


def git_text(*args, cwd=checkout):
    return git(*args, cwd=cwd).decode().strip()


def tracked_snapshot(names):
    rows = {}
    for name in names:
        file = checkout / name
        if file.is_symlink():
            rows[name] = {'kind': 'symlink', 'sha256': sha(os.readlink(file).encode())}
        else:
            assert file.is_file(), 'Missing tracked file: ' + name
            rows[name] = {'kind': 'file', 'sha256': digest(file)}
    return rows


def index_facts():
    index = Path(git_text('rev-parse', '--git-path', 'index'))
    if not index.is_absolute():
        index = checkout / index
    stage = git('ls-files', '--stage', '-z')
    flags = git('ls-files', '-v', '-z')
    assert all(row.startswith(b'H ') for row in flags.split(b'\0') if row), 'Sparse/assume-unchanged flags'
    return {'fileSHA256': digest(index), 'entriesSHA256': sha(stage), 'flagsSHA256': sha(flags)}, stage


def verify_assets():
    assert (assets / 'manifest.json').read_bytes() == manifest_bytes
    for name, expected in manifest['sha256'].items():
        target = proof_root / name
        assert not Path(name).is_absolute() and '..' not in Path(name).parts and not target.is_symlink()
        assert digest(target) == expected, name


def verify_no_checkout_credentials(root):
    check = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp',
                            '(extraheader|credential)'], cwd=root, capture_output=True)
    assert check.returncode == 1 and not check.stdout, 'Checkout retains credential configuration'


def capture_source():
    assert git_text('rev-parse', 'HEAD') == binding['candidateHead']
    assert git_text('rev-parse', 'HEAD^{tree}') == binding['candidateTree']
    assert git_text('remote', 'get-url', 'origin') == 'https://github.com/' + binding['candidateRepository']
    assert not git('diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--')
    assert not git('diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--')
    index, stage = index_facts()
    names = []
    for row in stage.split(b'\0'):
        if not row:
            continue
        metadata, raw_name = row.split(b'\t', 1)
        mode, _, level = metadata.decode().split(' ')
        name = raw_name.decode()
        assert level == '0' and mode in {'100644', '100755', '120000'}
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        names.append(name)
    assert len(names) == len(set(names))
    snapshot = tracked_snapshot(names)
    for name, expected in binding['sourceHashes'].items():
        assert snapshot[name] == {'kind': 'file', 'sha256': expected}, name
    save(evidence / 'tracked-candidate.json', {'index': index, 'tracked': snapshot})
    return {'index': index, 'tracked': snapshot, 'names': names}


def source_guard(label):
    index, _ = index_facts()
    expected = dict(initial_guard['tracked'])
    observed = {'head': git_text('rev-parse', 'HEAD'), 'tree': git_text('rev-parse', 'HEAD^{tree}'),
                'index': index, 'testOverlay': False, 'trackedCount': len(expected)}
    save(evidence / ('source-' + label + '.json'), observed)
    snapshot = tracked_snapshot(initial_guard['names'])
    changes = [name for name in expected if snapshot[name] != expected[name]]
    git_changes = [value.decode() for value in git('diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--').split(b'\0') if value]
    lock = checkout / 'node_modules/.pnpm/lock.yaml'
    current_lock = digest(lock) if lock.is_file() else None
    identity = sha(json.dumps({'head': observed['head'], 'tree': observed['tree'], 'tracked': snapshot}, sort_keys=True, separators=(',', ':')).encode())
    observed.update(changedBytes=changes, gitChangedPaths=git_changes, sourceIdentity=identity,
                    installedLockSHA256=current_lock, indexUnchanged=index == initial_guard['index'])
    save(evidence / ('source-' + label + '.json'), observed)
    assert observed['head'] == binding['candidateHead'] and observed['tree'] == binding['candidateTree']
    assert observed['indexUnchanged'], 'Index changed'
    assert not changes, changes
    assert git_changes == [], git_changes
    if installed_lock is not None:
        assert current_lock == installed_lock, 'Installed frozen lock changed'
    verify_no_checkout_credentials(checkout)
    verify_assets()
    observed['indexAfterComparisons'], _ = index_facts()
    save(evidence / ('source-' + label + '.json'), observed)
    assert observed['indexAfterComparisons'] == initial_guard['index'], 'Index changed during guard'
    return observed


def run(name, argv, env, timeout, diagnostic=False):
    receipt['phase'] = name
    print('PROOF_PHASE:' + name, flush=True)
    result = {'name': name, 'argv': argv, 'exitCode': None, 'termination': None,
              'executionTimeoutSeconds': timeout, 'cleanupReserveSeconds': 60,
              'diagnostic': diagnostic, 'status': 'incomplete'}
    started = time.monotonic()
    child = None
    completed = group_empty = False
    try:
        with (evidence / (name + '.stdout')).open('xb') as out, (evidence / (name + '.stderr')).open('xb') as err:
            child = subprocess.Popen(argv, cwd=checkout, env=env, stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=err, start_new_session=True)
            result['pid'] = result['pgid'] = child.pid
            while child.poll() is None:
                size = (evidence / (name + '.stdout')).stat().st_size + (evidence / (name + '.stderr')).stat().st_size
                if size > MAX_LOG_BYTES or time.monotonic() - started > timeout:
                    result['termination'] = 'output-limit' if size > MAX_LOG_BYTES else 'timeout'
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=60)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=10)
                    break
                time.sleep(0.2)
            result['exitCode'] = child.wait()
        assert result['termination'] is None, name + ' exceeded process limit'
        # Numeric check failure is a result, not evidence of an unjoined process.
        completed = True
    finally:
        result['leaderExitObserved'] = child is not None and child.poll() is not None
        if child is not None and result['leaderExitObserved']:
            deadline = time.monotonic() + 1
            while True:
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    group_empty = True
                    break
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.02)
        result['commandGroupEmpty'] = group_empty
        result['closureScope'] = 'outer command group; nested groups remain owned by unchanged canonical check wrappers'
        if not completed or not group_empty:
            receipt['unconfirmedCommandGroups'].append(name)
        result['status'] = ('passed' if result['exitCode'] == 0 else 'failed') if completed and group_empty else 'incomplete'
        for suffix in ['stdout', 'stderr']:
            log = evidence / (name + '.' + suffix)
            if log.is_file():
                result[suffix] = {'bytes': log.stat().st_size, 'sha256': digest(log)}
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(evidence / (name + '-result.json'), result)
    assert group_empty, name + ' left its command group active'
    assert sum(result[suffix]['bytes'] for suffix in ['stdout', 'stderr']) <= MAX_LOG_BYTES, name + ' exceeded log bound'
    if not diagnostic:
        assert result['exitCode'] == 0, name + ' failed'
    return result


def runtime_env(label):
    home = scratch / label
    home.mkdir(mode=0o700)
    env = {'PATH': environment_path, 'HOME': str(home), 'CI': 'true', 'GITHUB_ACTIONS': 'true', 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_TERMINAL_PROMPT': '0', 'COREPACK_HOME': str(scratch / 'corepack'), 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'}
    for key, name in [('TMPDIR', 'tmp'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                      ('XDG_DATA_HOME', 'data'), ('OPENCLAW_STATE_DIR', 'state')]:
        directory = home / name
        directory.mkdir(mode=0o700)
        env[key] = str(directory)
    return env

def budgeted_run(name, argv, env, maximum=None, diagnostic=False):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        receipt['outerDeadlineExhausted'] = True
        raise AssertionError('Outer diagnostic budget exhausted; product outcome remains unknown')
    limit = remaining if maximum is None else min(maximum, remaining)
    try:
        return run(name, argv, env, limit, diagnostic=diagnostic)
    finally:
        if time.monotonic() >= deadline:
            receipt['outerDeadlineExhausted'] = True


def canonical_closure_snapshot(name):
    # Native owners delete successful claims. Retained records are failure evidence;
    # their absence is never promoted to an independent success/release ledger.
    worker_root = checkout / '.artifacts/vitest-workers'
    assert not worker_root.is_symlink()
    workers = sorted(p.name for p in worker_root.iterdir()) if worker_root.exists() else []
    owners = []
    visited = 0
    if scratch is not None:
        # Only canonical runtime TMP namespaces can contain these resource owners;
        # dependency/package caches are not resource-owner registries.
        namespaces = [scratch / label / 'tmp' for label in ['bootstrap', 'build', 'lifecycle', 'channel-restart', 'runtime-generation']]
        directories = (entry for root in namespaces if root.exists()
                       for entry in os.walk(root, followlinks=False))
        for directory, children, _ in directories:
            visited += 1
            assert visited <= 100000, 'Ownership snapshot exceeds bound; retain state'
            children[:] = [n for n in children if not (Path(directory) / n).is_symlink()]
            if '.vitest-resource-owner' not in children:
                continue
            root = Path(directory) / '.vitest-resource-owner'
            row = {'path': str(root.relative_to(scratch)), 'claims': []}
            identity = (root / 'owner').read_text()
            assert re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', identity)
            row['identity'] = identity
            claims = root / 'claims'
            assert claims.is_dir() and not claims.is_symlink()
            for claim in sorted(claims.iterdir()):
                assert claim.is_dir() and not claim.is_symlink()
                release = claim / 'released'
                assert not release.is_symlink()
                released = release.is_file() and release.stat().st_size <= 128
                value = release.read_text() if released else None
                row['claims'].append({'id': claim.name, 'validRelease': value == identity + ':' + claim.name,
                                      'receiptSHA256': digest(release) if released else None})
            owners.append(row)
            children.remove('.vitest-resource-owner')
    artifact_owner = checkout / '.artifacts/dist-artifacts.lock'
    assert not artifact_owner.is_symlink()
    artifact_entries = sorted(p.name for p in artifact_owner.iterdir()) if artifact_owner.is_dir() else []
    retained_artifacts = [n for n in artifact_entries if n in {'owner.json', 'unjoined'} or n.startswith('child-')]
    facts = {'compiledWorkerDirectories': workers, 'retainedResourceOwners': owners,
             'artifactOwnerEntries': artifact_entries, 'retainedArtifactClaims': retained_artifacts,
             'successReceiptsDeletedByCanonicalOwner': True,
             'scope': 'retained-state snapshot plus source-bound native disposal; not an independent release ledger'}
    save(evidence / (name + '-ownership.json'), facts)
    return facts


def strip_ansi(text):
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


def parse_test_report(name, test_path_name):
    file = evidence / (name + '.json')
    assert file.is_file() and not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES
    data = json.loads(file.read_text())
    files = data.get('testResults', [])
    assert len(files) == 1 and files[0]['name'].endswith('/' + test_path_name), 'Wrong collected file'
    assert not files[0].get('message'), 'Module/hook error is not a regression'
    tests = files[0].get('assertionResults', [])
    assert tests and data.get('numTotalTests') == len(tests), 'Incomplete assertion collection'
    assert data.get('numPendingTests') == data.get('numTodoTests') == 0
    assert data.get('numRuntimeErrorTestSuites', 0) == 0
    console = '\n'.join((evidence / (name + suffix)).read_text(errors='replace') for suffix in ['.stdout', '.stderr'])
    clean = strip_ansi(console)
    assert not re.search(r'Vitest caught [1-9]\d* unhandled errors?|\[vitest\] UNHANDLED ERRORS \(', clean)
    for forbidden in ['Some tests are still running when generating the JSON report',
                      '[vitest] retained temporary namespace ', '[vitest-workers] retaining ',
                      'join failed', 'EPROCESSGROUP_CLEANUP_FAILED',
                      'Source changed during compiled subprocess invocation',
                      'Compiled subprocess artifact changed', 'Compiled subprocess build failed']:
        if forbidden in clean:
            receipt['unconfirmedCommandGroups'].append(name + '/canonical-cleanup')
            raise AssertionError('Incomplete canonical cleanup: ' + forbidden)
    assert not re.search(r'\n\s+at [^\n]*scripts/lib/(?:vitest-worker-run|vitest-worker-artifacts|vitest-process|managed-child-process)\.', clean), 'Canonical owner raised outside the test assertion'
    return data, tests, clean


def verify_case_result(case, result):
    name, target = case['name'], case['path']
    data, tests, _ = parse_test_report(name, target)
    observed = {'path': target, 'tests': tests, 'exitCode': result['exitCode'],
                'jsonSHA256': digest(evidence / (name + '.json')),
                'baselineProjectionIndependentlyReviewed': False}
    save(evidence / (name + '-observed.json'), observed)
    assert len(tests) == case['count']
    assert len({t['fullName'] for t in tests}) == len(tests)
    assert sorted(t['fullName'] for t in tests) == sorted(case['fullNames'])
    expected = case['baselineFailures'] if lane == 'baseline' else []
    failures = [t for t in tests if t['status'] == 'failed']
    assert sorted(t['fullName'] for t in failures) == sorted(f['fullName'] for f in expected)
    assert result['exitCode'] == (1 if expected else 0)
    assert data.get('success') is (not expected)
    assert data.get('numFailedTests') == len(expected)
    assert data.get('numPassedTests') == len(tests) - len(expected)
    for failure in failures:
        requirement = next(row for row in expected if row['fullName'] == failure['fullName'])
        messages = failure.get('failureMessages', [])
        assert len(messages) == 1, 'Unexpected setup/finally/aggregate error'
        assert all(fragment in messages[0] for fragment in requirement['requiredFailureFragments'])
    assert all(t['status'] == 'passed' and not t.get('failureMessages') for t in tests if t not in failures)
    observed.update(expectedFailureCount=len(expected), actualFailureCount=len(failures),
                    passedCount=len(tests) - len(failures), inventoryVerified=True)
    save(evidence / (name + '-verified.json'), observed)
    return observed


def verify_runtime_factory_observation(ledger):
    rows = [o for o in ledger['observations'] if o['phase'] == 'runtime-module-loader']
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == {'phase', 'resolvedTargets', 'factoryCalls'}
    assert row['resolvedTargets'] and all(isinstance(p, str) and p for p in row['resolvedTargets'])
    assert type(row['factoryCalls']) is int and row['factoryCalls'] > 0
    return row



def verify_native_closure(name, text):
    state = canonical_closure_snapshot(name)
    markers = [value for value in [
        '[vitest] retained temporary namespace ', '[vitest-workers] retaining ',
        'EPROCESSGROUP_CLEANUP_FAILED', 'Unreleased Vitest resource claim:',
        'Vitest resource owner changed:', 'Source changed during compiled subprocess invocation',
        'Compiled subprocess artifact changed',
        'Managed command cleanup could not verify child, process group, and output closure',
        '[dist artifacts] child cleanup unverified; retained ',
    ] if value in text]
    state['cleanupFailureMarkers'] = markers
    save(evidence / (name + '-closure-verdict.json'), state)
    assert not markers and not state['compiledWorkerDirectories'] and not state['retainedResourceOwners'] and not state['retainedArtifactClaims'], 'Canonical ownership remains uncertain; retain state'
    return state



def verify_reload_ledger(ledger):
    contract = binding['ledgerContract']
    assert contract['reviewed'] is True
    verify_runtime_factory_observation(ledger)
    assert set(ledger) == {'events', 'monitors', 'observations', 'cleanup'}
    channels = contract['channelIds']
    assert channels == ['binding-first', 'binding-second']
    assert ledger['cleanup'] == contract['cleanup'] == {
        'serversClosed': True, 'socketsClosed': True, 'monitorsStopped': True, 'skipEnvRestored': True,
    }
    assert all(value is True for value in ledger['cleanup'].values())
    monitors = ledger['monitors']
    assert len(monitors) == 2 * len(channels)
    assert sorted(m['channelId'] for m in monitors) == sorted(channels * 2)
    for monitor in monitors:
        assert set(monitor) == {'channelId', 'runtimeId', 'stopped', 'aborted'}
        assert type(monitor['runtimeId']) is int and monitor['runtimeId'] > 0
        assert monitor['stopped'] is True and monitor['aborted'] is True
    observations = [o for o in ledger['observations'] if o['phase'] != 'runtime-module-loader']
    assert [o['phase'] for o in observations] == contract['requiredPhases'] == [
        'initial', 'replacement', 'retired-binding-rejected', 'retired-binding-rejected',
        'successor-handoff', 'settled-channels',
    ]
    assert set(observations[0]) == {'phase', 'probes'}
    initial = observations[0]['probes']
    assert len(initial) == 2 and initial[0] == initial[1]
    assert set(observations[1]) == {'phase', 'probe'}
    fresh = observations[1]['probe']
    for probe in [*initial, fresh]:
        assert set(probe) == {'registryId', 'sessionsId', 'placementId', 'reloadSettled'}
        assert all(type(probe[k]) is int and probe[k] > 0 for k in ['registryId', 'sessionsId', 'placementId'])
        assert probe['reloadSettled'] is True
    assert fresh['registryId'] != initial[0]['registryId']
    assert all(fresh[k] == initial[0][k] for k in ['sessionsId', 'placementId'])
    rejected = observations[2:4]
    assert sorted(o['channelId'] for o in rejected) == channels
    for observation in rejected:
        assert set(observation) == {'phase', 'channelId', 'runtimeId'}
        assert type(observation['runtimeId']) is int and observation['runtimeId'] > 0
    old_ids = {row['channelId']: row['runtimeId'] for row in rejected}
    assert len(set(old_ids.values())) == 1
    new_ids = {}
    for channel in channels:
        rows = [m for m in monitors if m['channelId'] == channel]
        assert len([m for m in rows if m['runtimeId'] == old_ids[channel]]) == 1
        successors = [m for m in rows if m['runtimeId'] != old_ids[channel]]
        assert len(successors) == 1
        new_ids[channel] = successors[0]['runtimeId']
    assert len(set(new_ids.values())) == 1
    assert observations[4] == {'phase': 'successor-handoff', 'predecessorsStopped': True}
    assert observations[4]['predecessorsStopped'] is True
    assert set(observations[5]) == {'phase', 'channels'}
    actual_channels = observations[5]['channels']
    expected_channels = [{
        'channelId': channel, 'activeCount': 1, 'oldStopped': True, 'freshRuntime': True,
        'stoppedBeforeRegistration': True, 'startedFromNewRegistration': True,
        'response': {'ok': True, 'registryId': fresh['registryId']},
    } for channel in channels]
    assert sorted(actual_channels, key=lambda x: x['channelId']) == expected_channels
    for channel in actual_channels:
        assert type(channel['activeCount']) is int and channel['activeCount'] == 1
        assert all(channel[k] is True for k in ['oldStopped', 'freshRuntime', 'stoppedBeforeRegistration', 'startedFromNewRegistration'])
        assert channel['response']['ok'] is True
    events = ledger['events']
    phase_names = ['initial-requests-succeeded', 'reload-request', 'reload-settled', 'channels-observed', 'cleanup']
    phase_indexes = {}
    for name in phase_names:
        indexes = [i for i, event in enumerate(events) if event['event'] == name]
        assert len(indexes) == 1, 'Missing/duplicate lifecycle event: ' + name
        phase_indexes[name] = indexes[0]
    assert list(phase_indexes.values()) == sorted(phase_indexes.values())
    assert phase_indexes['cleanup'] == len(events) - 1
    for event in events:
        if event['event'] in phase_names:
            assert set(event) == {'event'}
        else:
            assert event['event'] in {'register', 'start', 'stop-aborted', 'stopped'}
            assert set(event) == {'event', 'channelId', 'runtimeId'}
            assert event['channelId'] in channels
            assert type(event['runtimeId']) is int and event['runtimeId'] > 0
    registrations_after_reload = [i for i, event in enumerate(events)
        if event['event'] == 'register' and phase_indexes['reload-request'] < i]
    assert registrations_after_reload
    first_new_registration = min(registrations_after_reload)
    assert first_new_registration < phase_indexes['reload-settled']
    for channel in channels:
        def indexes(name, runtime_id=None):
            return [i for i, event in enumerate(events)
                    if event['event'] == name and event.get('channelId') == channel
                    and (runtime_id is None or event.get('runtimeId') == runtime_id)]
        old_id, new_id = old_ids[channel], new_ids[channel]
        starts, stops, stop_hooks = indexes('start'), indexes('stopped'), indexes('stop-aborted')
        assert len(starts) == len(stops) == len(stop_hooks) == 2
        old_start, new_start = indexes('start', old_id), indexes('start', new_id)
        old_stop, new_stop = indexes('stopped', old_id), indexes('stopped', new_id)
        assert len(old_start) == len(new_start) == len(old_stop) == len(new_stop) == 1
        assert old_start[0] < phase_indexes['initial-requests-succeeded']
        old_registrations = indexes('register', old_id)
        assert old_registrations and min(old_registrations) < old_start[0]
        assert phase_indexes['reload-request'] < old_stop[0] < first_new_registration
        new_registrations = indexes('register', new_id)
        assert len(new_registrations) == 1
        assert first_new_registration <= new_registrations[0] < phase_indexes['reload-settled']
        assert new_registrations[0] < new_start[0] < phase_indexes['channels-observed']
        assert phase_indexes['channels-observed'] < new_stop[0] < phase_indexes['cleanup']
        # stopAccount resolves the current descriptor, while each monitor finally owns its runtime ID.
        assert len([i for i in stop_hooks if phase_indexes['reload-request'] < i < old_stop[0]]) == 1
        assert len([i for i in stop_hooks if phase_indexes['channels-observed'] < i < new_stop[0]]) == 1
    save(evidence / 'reload-ledger.json', ledger)
    save(evidence / 'reload-ledger-verified.json', {
        'initialRegistryId': initial[0]['registryId'], 'replacementRegistryId': fresh['registryId'],
        'sessionAndPlacementPreserved': True, 'oldRuntimeIds': old_ids, 'newRuntimeIds': new_ids,
        'phaseIndexes': phase_indexes, 'candidateChannels': actual_channels,
        'firstNewRegistrationIndex': first_new_registration,
        'cleanup': ledger['cleanup'], 'runtimeIdsWereObservedNotPredicted': True,
    })
    return digest(evidence / 'reload-ledger.json')

def verify_close_ledger(ledger):
    assert set(ledger) == {'events', 'monitors', 'observations', 'cleanup'}
    factory = verify_runtime_factory_observation(ledger)
    assert ledger['cleanup'] == packet['ledgerContract']['cleanup']
    observations = [o for o in ledger['observations'] if o['phase'] != 'runtime-module-loader']
    expected_phases = ['two-gateways-started', 'first-close-completed', 'second-gateway-still-bound']
    if lane == 'candidate':
        expected_phases += ['both-closes-completed']
    expected_phases += ['close-failure-cleanup', 'close-cleanup-monitors-joined']
    assert [o['phase'] for o in observations] == expected_phases
    started, closed, surviving = observations[:3]
    assert set(started) == {'phase', 'firstProbes', 'secondProbes'}
    first, second = started['firstProbes'], started['secondProbes']
    assert len(first) == len(second) == 2 and first[0] == first[1] and second[0] == second[1]
    for probes in [first, second]:
        for probe in probes:
            assert set(probe) == {'registryId', 'sessionsId', 'placementId', 'reloadSettled'}
            assert probe['reloadSettled'] is True
            assert all(type(probe[k]) is int and probe[k] > 0 for k in ['registryId', 'sessionsId', 'placementId'])
    assert all(first[0][k] != second[0][k] for k in ['registryId', 'sessionsId', 'placementId'])
    assert surviving == {'phase': 'second-gateway-still-bound', 'probes': second}
    assert set(closed) == {'phase', 'first', 'second'}
    first_ids, second_ids = ['binding-a-only', 'binding-shared'], ['binding-b-only', 'binding-shared']
    assert [m['channelId'] for m in closed['first']] == first_ids
    assert [m['channelId'] for m in closed['second']] == second_ids
    before_cleanup = closed['first'] + closed['second']
    assert len({m['runtimeId'] for m in closed['first']}) == len({m['runtimeId'] for m in closed['second']}) == 1
    assert len({m['runtimeId'] for m in before_cleanup}) == 2
    for row in before_cleanup:
        assert set(row) == {'channelId', 'runtimeId', 'stopped', 'aborted', 'stopHooks'}
        assert type(row['runtimeId']) is int and row['runtimeId'] > 0
        assert type(row['stopped']) is bool and type(row['aborted']) is bool
        assert all(set(h) == {'ownSignal', 'aborted'} and type(h['ownSignal']) is bool and type(h['aborted']) is bool for h in row['stopHooks'])
    def expected(rows, stopped):
        return [{'channelId': m['channelId'], 'runtimeId': m['runtimeId'], 'stopped': stopped,
                 'aborted': stopped, 'stopHooks': [{'ownSignal': True, 'aborted': True}] if stopped else []} for m in rows]
    wanted = {'phase': 'first-close-completed', 'first': expected(closed['first'], True), 'second': expected(closed['second'], False)}
    if lane == 'baseline':
        predicted_first = expected(closed['first'], False)
        predicted_first[1].update(stopped=True, aborted=True)
        predicted_second = expected(closed['second'], False)
        predicted_second[1]['stopHooks'] = [{'ownSignal': False, 'aborted': True}]
        assert closed == {'phase': 'first-close-completed', 'first': predicted_first, 'second': predicted_second}, 'Close RED differs from reviewed ownership prediction'
    else:
        assert closed == wanted
        assert observations[3] == {'phase': 'both-closes-completed', 'channels': expected(before_cleanup, True)}
    cleanup = observations[-2]
    assert set(cleanup) == {'phase', 'released'}
    admitted = {(m['channelId'], m['runtimeId']) for m in before_cleanup}
    released = [(m['channelId'], m['runtimeId']) for m in cleanup['released']]
    assert len(released) == len(set(released)) and set(released).issubset(admitted)
    if lane == 'candidate':
        assert released == [], 'GREEN may not need synthetic failure release'
    assert observations[-1] == {'phase': 'close-cleanup-monitors-joined'}
    final = ledger['monitors']
    assert len(final) == 4 and {(m['channelId'], m['runtimeId']) for m in final} == admitted
    assert all(set(m) == {'channelId', 'runtimeId', 'stopped', 'aborted'} and m['stopped'] is True and m['aborted'] is True for m in final)
    events = ledger['events']
    assert events[-1] == {'event': 'cleanup'}
    assert sum(x['event'] == 'start' for x in events) == 4
    assert all(x['event'] in {'register', 'start', 'stop-aborted', 'stop-unaborted', 'stopped', 'first-close-request', 'second-close-request', 'cleanup'} for x in events)
    assert sum(x['event'] == 'first-close-request' for x in events) == 1
    assert sum(x['event'] == 'second-close-request' for x in events) == (1 if lane == 'candidate' else 0)
    save(evidence / 'close-ledger.json', ledger)
    save(evidence / 'close-ledger-verified.json', {'firstClose': closed, 'expectedFirstClose': wanted,
         'survivingProbes': surviving, 'failureCleanup': cleanup, 'finalCleanup': ledger['cleanup'],
         'factoryObservation': factory, 'baselineProjectionIndependentlyReviewed': False,
         'scope': 'Immutable first-close observation is the verdict; later synthetic failure release is cleanup only'})
    return digest(evidence / 'close-ledger.json')


def verify_lifecycle_ledgers():
    text = strip_ansi((evidence / 'lifecycle.stdout').read_text(errors='replace'))
    marker = 'PROOF_126547_LEDGER:'
    rows = [json.loads(line[len(marker):]) for line in text.splitlines() if line.startswith(marker)]
    assert len(rows) == 2, 'Expected separate reload and two-Gateway close ledgers'
    reload_rows = [row for row in rows if any(o['phase'] == 'settled-channels' for o in row['observations'])]
    close_rows = [row for row in rows if any(o['phase'] == 'two-gateways-started' for o in row['observations'])]
    assert len(reload_rows) == len(close_rows) == 1 and reload_rows[0] is not close_rows[0]
    return {'reload': verify_reload_ledger(reload_rows[0]), 'close': verify_close_ledger(close_rows[0])}



try:
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    assert os_release.get('ID', '').strip(chr(34)) == 'ubuntu'
    assert os_release.get('VERSION_ID', '').strip(chr(34)) == '24.04'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-plugin-registry-lifecycle-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'source'
    assert binding['runnable'] is True and binding['executionMayRun'] is True, 'Diagnostic packet is disabled'
    assert binding['setupCacheContract'] == 'canonical-pr-restore-miss-private-relocated', 'Setup/cache contract needs explicit review'
    assert binding['nodeVersion'] == '24.19.0'
    assert binding['candidateRepository'] == 'steipete/openclaw'
    assert packet['comparison']['originalFailedCiCheckoutProven'] is False
    assert set(packet['lanes']) == {'baseline', 'candidate'}
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateHead'] or ''), 'Source head is unbound'
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateTree'] or ''), 'Source tree is unbound'
    assert binding['parents'] and all(re.fullmatch(r'[a-f0-9]{40}', parent) for parent in binding['parents'])
    assert packet['testContractReviewed'] is True, 'Expanded test contract is unbound'
    cases = packet['testCases']
    assert [case['name'] for case in cases] == ['lifecycle', 'channel-restart', 'runtime-generation']
    assert [case['path'] for case in cases] == TEST_PATHS
    assert [case['count'] for case in cases] == [6, 8, 3]
    assert [len(case['baselineFailures']) for case in cases] == [1, 2, 0]
    assert all(case['count'] == len(case['fullNames']) == len(set(case['fullNames'])) for case in cases)
    for case in cases:
        assert all(row['fullName'] in case['fullNames'] and row['requiredFailureFragments'] for row in case['baselineFailures'])
        assert all(all(isinstance(fragment, str) and fragment for fragment in row['requiredFailureFragments']) for row in case['baselineFailures'])
        assert binding['sourceHashes'][case['path']] == case['testSHA256'][lane]
    assert packet['ledgerContract']['reviewed'] is True
    if lane == 'candidate':
        baseline = packet['baselineAcceptance']
        assert baseline['reviewed'] is True and baseline['normalFailedJob'] is True
        assert baseline['failureCount'] == 3 and baseline['passedCount'] == 14
        assert baseline['sourceHead'] == packet['lanes']['baseline']['candidateHead']
        assert re.fullmatch(r'[a-f0-9]{40}', baseline['sourceHead'] or '')
        assert re.fullmatch(r'[a-f0-9]{64}', baseline['artifactSHA256'] or '')
        assert len(baseline['files']) == 3
        for case, observed in zip(cases, baseline['files']):
            assert observed['path'] == case['path'] and observed['count'] == case['count']
            assert sorted(observed['fullNames']) == sorted(case['fullNames'])
            assert re.fullmatch(r'[a-f0-9]{64}', observed['jsonSHA256'] or '')
    assert packet['fixtureEquivalenceReviewed'] is True
    assert set(binding['sourceHashes']) == set(binding['requiredSourcePaths'])
    assert binding['sourceHashes'] and all(re.fullmatch(r'[a-f0-9]{64}', v or '') for v in binding['sourceHashes'].values())
    assert not started_file.is_symlink() and started_file.stat().st_size <= 1024
    started = json.loads(started_file.read_text())
    assert started['runId'] == os.environ['GITHUB_RUN_ID'] and started['attempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert started['job'] == os.environ['GITHUB_JOB']
    assert binding['jobBudgetSeconds'] == 5400 and binding['cleanupAndArtifactReserveSeconds'] == 240
    elapsed = (time.monotonic_ns() - started['monotonicNs']) / 1e9
    assert 0 <= elapsed < 5400
    deadline = time.monotonic() + 5400 - 240 - elapsed
    save(evidence / 'job-budget.json', {'firstStep': started, 'controllerElapsedSeconds': elapsed,
         'jobBudgetSeconds': 5400, 'cleanupAndArtifactReserveSeconds': 240,
         'innerWatchdogAndRetry': 'Unchanged native explicit-file run-vitest/test-projects policy; no caller override'})
    manifest_bytes = (assets / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest.get('incomplete') is False
    assert git_text('rev-parse', 'HEAD', cwd=proof_root) == os.environ['GITHUB_SHA']
    verify_no_checkout_credentials(proof_root)
    verify_no_checkout_credentials(checkout)
    verify_assets()
    initial_guard = capture_source()
    header = git('cat-file', 'commit', 'HEAD').split(b'\n\n', 1)[0].decode()
    parents = [line[7:] for line in header.splitlines() if line.startswith('parent ')]
    assert parents == binding['parents']
    save(evidence / 'commit-provenance.json', {'head': binding['candidateHead'], 'tree': binding['candidateTree'],
         'parents': parents, 'comparison': packet['comparison']})
    assert not (checkout / 'node_modules').exists()
    node = str(Path(shutil.which('node')).resolve())
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file() and corepack.resolve().is_relative_to(Path(node).parent.parent)
    scratch = Path(tempfile.mkdtemp(prefix='p126547-lifecycle-', dir='/tmp')).resolve()
    for name in ['corepack', 'bin']:
        (scratch / name).mkdir(mode=0o700)
    environment_path = str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin'
    bootstrap = runtime_env('bootstrap')
    provenance = {key: os.environ[key] for key in ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
                  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']}
    save(evidence / 'hosted-platform.json', {'osRelease': os_release, 'machine': platform.machine(),
         'logicalCpuCount': os.cpu_count(), 'physicalMemoryBytes': os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')})
    save(evidence / 'hosted-source.json', {'binding': binding, 'hostedProvenance': provenance,
         'nodeExecutableSHA256': digest(node), 'corepackLauncherSHA256': digest(corepack.resolve()),
         'manifestSHA256': digest(assets / 'manifest.json'), 'bootstrapEnvNames': sorted(bootstrap)})
    budgeted_run('node-version', [node, '--version'], bootstrap, 60)
    assert (evidence / 'node-version.stdout').read_text().strip() == 'v24.19.0'
    assert json.loads((checkout / 'package.json').read_text())['packageManager'] == binding['packageManager']
    budgeted_run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], bootstrap, 300)
    budgeted_run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], bootstrap, 300)
    pnpm = str(scratch / 'bin/pnpm')
    budgeted_run('pnpm-version', [pnpm, '--version'], bootstrap, 60)
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    generation = os.environ['CACHE_GENERATION']
    assert re.fullmatch(r'[a-f0-9]{64}', generation), 'Missing actual Actions hashFiles generation'
    vitest_cache = scratch / 'vitest-fs-cache'
    node_cache = scratch / 'node-compile-cache'
    vitest_cache.mkdir(mode=0o700)
    node_cache.mkdir(mode=0o700)
    (vitest_cache / '.openclaw-transform-generation').write_text(generation + '\n')
    save(evidence / 'cache-generation.json', {'generation': generation,
         'owner': '.github/actions/setup-node-env/action.yml',
         'hashFilesPatterns': packet['cacheGenerationPatterns'],
         'cacheMode': 'restore', 'restoreOutcome': 'intentional fresh miss; no restore attempted',
         'relocatedPrivateRoots': [str(vitest_cache), str(node_cache)],
         'writers': 0, 'nodeCompileCachePortable': '1', 'historicalSeedReproduced': False})
    # Canonical setup prepares these roots before pnpm's install/postinstall phase.
    # Every executable phase keeps the same enabled-cache MISS, writer and portability facts.
    cache_env = {
        'OPENCLAW_VITEST_FS_MODULE_CACHE_PATH': str(vitest_cache),
        'OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER': '0',
        'NODE_COMPILE_CACHE': str(node_cache), 'NODE_COMPILE_CACHE_PORTABLE': '1',
        'OPENCLAW_NODE_COMPILE_CACHE_WRITER': '0',
    }
    bootstrap.update(cache_env)
    save(evidence / 'install-policy.json', {'parentEnv': bootstrap,
         'cacheConfiguredBeforeInstall': True, 'sameRootsForBuildAndTest': True})
    source_guard('before-install')
    receipt['runtimeStarted'] = True
    receipt['nativeClosureVerified'] = False
    try:
        installation = budgeted_run('install', [pnpm, 'install', '--config.ignore-scripts=false', '--config.engine-strict=false',
                      '--config.enable-pre-post-scripts=true', '--config.side-effects-cache=true',
                      '--frozen-lockfile', '--prefer-offline'], bootstrap, 1200, diagnostic=True)
    finally:
        source_guard('after-install-command')
    install_text = '\n'.join((evidence / ('install.' + suffix)).read_text(errors='replace') for suffix in ['stdout', 'stderr'])
    receipt['installClosure'] = verify_native_closure('after-install', install_text)
    receipt['nativeClosureVerified'] = True
    assert installation['exitCode'] == 0, 'Frozen install failed; build and shard not admitted'
    installed_lock = digest(checkout / 'node_modules/.pnpm/lock.yaml')
    save(evidence / 'install-lock.json', {'tracked': digest(checkout / 'pnpm-lock.yaml'), 'installed': installed_lock})
    source_guard('installed')
    build_env = runtime_env('build')
    build_env.update(cache_env)
    save(evidence / 'build-policy.json', {'argv': [pnpm, 'build'], 'parentEnv': build_env,
         'fullBuild': True, 'sourceOverlay': False, 'cacheConfiguredBeforeInstall': True})
    receipt['nativeClosureVerified'] = False
    source_guard('before-full-build')
    try:
        built = budgeted_run('full-build', [pnpm, 'build'], build_env, 1800, diagnostic=True)
    finally:
        source_guard('after-full-build')
    build_text = '\n'.join((evidence / ('full-build.' + suffix)).read_text(errors='replace') for suffix in ['stdout', 'stderr'])
    receipt['buildClosure'] = verify_native_closure('after-full-build', build_text)
    receipt['nativeClosureVerified'] = True
    assert built['exitCode'] == 0, 'Full build failed; tests not admitted'
    results = []
    for case in cases:
        name, target = case['name'], case['path']
        runtime = runtime_env(name)
        runtime.update(cache_env)
        argv = [node, 'scripts/run-vitest.mjs', 'run']
        if target == TEST_PATH:
            argv += ['--config', 'test/vitest/vitest.gateway-server.config.ts']
        argv += [target, '--reporter=verbose', '--reporter=json',
                 '--outputFile=' + str(evidence / (name + '.json'))]
        save(evidence / (name + '-policy.json'), {'argv': argv, 'parentEnv': runtime,
             'sourceOverlay': False, 'cacheConfiguredBeforeInstall': True,
             'timeoutsRetriesWorkers': 'Native owner defaults; no caller override; outer job-budget exhaustion is incomplete'})
        before = canonical_closure_snapshot('before-' + name)
        assert not before['compiledWorkerDirectories'] and not before['retainedResourceOwners'] and not before['retainedArtifactClaims']
        receipt['nativeClosureVerified'] = False
        if target == TEST_PATH:
            receipt['lifecycleStarted'] = True
        source_guard('before-' + name)
        try:
            result = budgeted_run(name, argv, runtime, diagnostic=True)
        finally:
            source_guard('after-' + name)
        text = '\n'.join((evidence / (name + '.' + suffix)).read_text(errors='replace') for suffix in ['stdout', 'stderr'])
        receipt['nativeClosure'] = verify_native_closure('after-' + name, text)
        receipt['nativeClosureVerified'] = True
        observed = verify_case_result(case, result)
        if target == TEST_PATH:
            receipt['lifecycleLedgersSHA256'] = verify_lifecycle_ledgers()
            receipt['lifecycleLedgersVerified'] = True
        results.append(observed)
    save(evidence / 'three-file-result.json', {'lane': lane, 'files': results,
         'totalPassed': sum(row['passedCount'] for row in results),
         'totalFailed': sum(row['actualFailureCount'] for row in results)})
    receipt.update(diagnosticComplete=True, passed=lane == 'candidate', phase='complete',
                   expectedRedObserved=lane == 'baseline', candidateGreenObserved=lane == 'candidate')
    # Baseline remains an ordinary failed job after all three expected-result files finish.

except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if initial_guard is not None:
            source_guard('before-cleanup')
        final_ownership = canonical_closure_snapshot('final')
        assert not final_ownership['compiledWorkerDirectories'] and not final_ownership['retainedResourceOwners'] and not final_ownership['retainedArtifactClaims'], 'Final native ownership retained; do not delete scratch'
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        assert not receipt.get('runtimeStarted') or receipt.get('nativeClosureVerified'), 'Native closure incomplete; retain state'
        assert not receipt.get('lifecycleStarted') or receipt.get('lifecycleLedgersVerified'), 'Lifecycle ledger/cleanup incomplete; retain state'
        if initial_guard is not None:
            source_guard('final')
        if scratch is not None:
            shutil.rmtree(scratch)
        receipt['ownedScratchRemoved'] = True
    except Exception as error:
        receipt['ownedScratchRemoved'] = False
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = receipt['diagnosticComplete'] = False
    try:
        files = [file for file in evidence.rglob('*') if file.is_file()]
        assert all(not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES for file in files)
        assert sum(file.stat().st_size for file in files) <= 64 * 1024 * 1024
        save(evidence / 'artifact-manifest.json', {str(file.relative_to(evidence)): digest(file) for file in files})
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = receipt['diagnosticComplete'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'lane', 'diagnosticComplete']}))
sys.exit(0 if receipt['passed'] else 1)
