"""Reviewed candidate-only hosted proof. Executes only an exact committed candidate."""
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
checkout, evidence = [Path(value).resolve() for value in sys.argv[1:]]
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
binding = json.loads((assets / 'execution-binding.json').read_text())
proof_root = assets.parents[3]
receipt = {'schema': 'openclaw-126547-candidate-hosted-v1', 'passed': False, 'phase': 'setup',
           'candidateGreenVerified': False, 'lifecycleLedgerVerified': False, 'lifecycleStarted': False,
           'commands': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': []}
scratch = node = installed_lock = initial_guard = None
manifest = manifest_bytes = None
MAX_LOG_BYTES = 16 * 1024 * 1024
index_observations = []
index_capture_bytes = {}
TEST_PATH = 'src/gateway/server-plugins.lifecycle.test.ts'
RESTART_PATH = 'src/gateway/server-reload-channel-restart.test.ts'
GENERATION_PATH = 'src/gateway/server-plugin-runtime-generation.test.ts'
TEST_PATHS = [TEST_PATH, RESTART_PATH, GENERATION_PATH]
test_path = checkout / TEST_PATH

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


def run(name, argv, env, timeout, exits=(0,)):
    receipt['phase'] = name
    print('PROOF_PHASE:' + name, flush=True)
    result = {'name': name, 'argv': argv, 'exitCode': None, 'termination': None,
              'executionTimeoutSeconds': timeout, 'cleanupReserveSeconds': 60}
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
        assert result['exitCode'] in exits, name + ' failed'
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
        result['closureScope'] = 'outer command group; nested Vitest groups belong to canonical runner'
        if not completed or not group_empty:
            receipt['unconfirmedCommandGroups'].append(name)
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(evidence / (name + '-result.json'), result)
    assert group_empty, name + ' left its command group active'
    return result


def runtime_env(label):
    home = scratch / label
    home.mkdir(mode=0o700)
    env = {'PATH': environment_path, 'HOME': str(home), 'CI': '1', 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_TERMINAL_PROMPT': '0', 'COREPACK_HOME': str(scratch / 'corepack'), 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'}
    for key, name in [('TMPDIR', 'tmp'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                      ('XDG_DATA_HOME', 'data'), ('OPENCLAW_STATE_DIR', 'state')]:
        directory = home / name
        directory.mkdir(mode=0o700)
        env[key] = str(directory)
    return env


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


def parse_green(name, target):
    data, tests, _ = parse_test_report(name, target)
    assert data.get('success') is True and data.get('numFailedTests') == 0
    assert data.get('numPassedTests') == len(tests)
    assert all(t['status'] == 'passed' and not t.get('failureMessages') for t in tests)
    result = {'path': target, 'tests': tests, 'passedCount': len(tests),
              'jsonSHA256': digest(evidence / (name + '.json'))}
    save(evidence / (name + '-verified.json'), result)
    return result


def verify_lifecycle_ledger():
    contract = binding['ledgerContract']
    assert contract['reviewed'] is True
    console = strip_ansi((evidence / 'candidate-lifecycle.stdout').read_text(errors='replace'))
    marker = contract['stdoutPrefix']
    assert marker == 'PROOF_126547_LEDGER:'
    rows = [line[len(marker):] for line in console.splitlines() if line.startswith(marker)]
    assert len(rows) == 1, 'Missing/duplicate terminal lifecycle ledger'
    ledger = json.loads(rows[0])
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
    observations = ledger['observations']
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
    save(evidence / 'lifecycle-ledger.json', ledger)
    save(evidence / 'lifecycle-ledger-verified.json', {
        'initialRegistryId': initial[0]['registryId'], 'replacementRegistryId': fresh['registryId'],
        'sessionAndPlacementPreserved': True, 'oldRuntimeIds': old_ids, 'newRuntimeIds': new_ids,
        'phaseIndexes': phase_indexes, 'candidateChannels': actual_channels,
        'firstNewRegistrationIndex': first_new_registration,
        'cleanup': ledger['cleanup'], 'runtimeIdsWereObservedNotPredicted': True,
    })
    return digest(evidence / 'lifecycle-ledger.json')


try:
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-plugin-reload-candidate-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'candidate'
    assert binding['runnable'] is True and binding['candidateMayRun'] is True, 'Candidate packet is not sealed'
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateHead'] or '')
    assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', binding['candidateRepository'] or '')
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateTree'] or '')
    assert binding['committedTestSHA256'] == '847524697e23961b36e88d1b728c9d02082e23698d7909b139eb92e276f509aa'
    assert binding['nodeVersion'] == '24.19.0'
    assert binding['testPath'] == TEST_PATH
    assert [case['path'] for case in binding['testCases']] == TEST_PATHS
    assert [case['count'] for case in binding['testCases']] == [5, 6, 3]
    assert all(case['count'] == len(case['fullNames']) for case in binding['testCases'])
    assert set(binding['sourceHashes']) == set(binding['requiredSourcePaths'])
    assert set(TEST_PATHS + ['package.json', 'pnpm-lock.yaml', 'scripts/run-vitest.mjs']).issubset(binding['sourceHashes'])
    assert binding['ledgerContract']['reviewed'] is True
    manifest_bytes = (assets / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest.get('incomplete') is False, 'Publication asset manifest is incomplete'
    assert git_text('rev-parse', 'HEAD', cwd=proof_root) == os.environ['GITHUB_SHA']
    verify_no_checkout_credentials(proof_root)
    verify_no_checkout_credentials(checkout)
    verify_assets()
    assert binding['sourceHashes'][TEST_PATH] == binding['committedTestSHA256']
    assert all(re.fullmatch(r'[a-f0-9]{64}', value or '') for value in binding['sourceHashes'].values())
    save(evidence / 'git-toolchain.json', {'version': git_text('--version'),
         'executableSHA256': digest('/usr/bin/git'), 'optionalLocks': '0',
         'porcelainDiffIndex': 'exact disposable copy; real index remains guarded'})
    initial_guard = capture_source()
    assert not (checkout / 'node_modules').exists()
    assert not test_path.is_symlink()
    assert digest(test_path) == binding['committedTestSHA256']
    node = str(Path(shutil.which('node')).resolve())
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file() and corepack.resolve().is_relative_to(Path(node).parent.parent)
    scratch = Path(tempfile.mkdtemp(prefix='p126547-', dir='/tmp')).resolve()
    for name in ['corepack', 'bin']:
        (scratch / name).mkdir(mode=0o700)
    environment_path = str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin'
    bootstrap = runtime_env('bootstrap')
    provenance = {key: os.environ[key] for key in ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
                  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']}
    save(evidence / 'hosted-source.json', {'binding': binding, 'hostedProvenance': provenance,
         'nodeExecutableSHA256': digest(node), 'corepackLauncherSHA256': digest(corepack.resolve()),
         'manifestSHA256': digest(assets / 'manifest.json'), 'bootstrapEnvNames': sorted(bootstrap)})
    run('node-version', [node, '--version'], bootstrap, 60)
    assert (evidence / 'node-version.stdout').read_text().strip() == 'v24.19.0'
    assert json.loads((checkout / 'package.json').read_text())['packageManager'] == binding['packageManager']
    run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], bootstrap, 300)
    run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], bootstrap, 300)
    pnpm = str(scratch / 'bin/pnpm')
    run('pnpm-version', [pnpm, '--version'], bootstrap, 60)
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    run('install', [pnpm, 'install', '--frozen-lockfile'], bootstrap, 1200)
    installed_lock = digest(checkout / 'node_modules/.pnpm/lock.yaml')
    save(evidence / 'install-lock.json', {'tracked': digest(checkout / 'pnpm-lock.yaml'), 'installed': installed_lock})
    source_guard('installed')
    try:
        run('full-build', [pnpm, 'build'], runtime_env('build'), 1800)
    finally:
        source_guard('built')
    results = []
    for case in binding['testCases']:
        name, target = case['name'], case['path']
        if target == TEST_PATH:
            receipt['lifecycleStarted'] = True
        argv = [node, 'scripts/run-vitest.mjs', 'run']
        if target == TEST_PATH:
            argv += ['--config', 'test/vitest/vitest.gateway-server.config.ts']
        argv += [target, '--reporter=verbose', '--reporter=json',
                 '--outputFile=' + str(evidence / (name + '.json'))]
        try:
            run(name, argv, runtime_env(name), 1800 if target == TEST_PATH else 900)
        finally:
            source_guard(name)
        result = parse_green(name, target)
        assert result['passedCount'] == case['count']
        assert sorted(test['fullName'] for test in result['tests']) == sorted(case['fullNames'])
        results.append(result)
        if target == TEST_PATH:
            receipt['lifecycleLedgerSHA256'] = verify_lifecycle_ledger()
            receipt['lifecycleLedgerVerified'] = True
    save(evidence / 'candidate-green-phase.json', {'files': results, 'totalPassed': sum(x['passedCount'] for x in results)})
    receipt.update(passed=True, phase='complete', candidateGreenVerified=True)

except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if initial_guard is not None:
            source_guard('before-cleanup')
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        assert not receipt['lifecycleStarted'] or receipt['lifecycleLedgerVerified'], 'Lifecycle or its cleanup ledger incomplete; retain private runtime'
        if initial_guard is not None:
            source_guard('final')
        if scratch is not None:
            shutil.rmtree(scratch)
        receipt['ownedScratchRemoved'] = True
    except Exception as error:
        receipt['ownedScratchRemoved'] = False
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    # Only explicitly written synthetic logs/reports/hashes enter evidence, never runtime HOME.
    try:
        files = [file for file in evidence.rglob('*') if file.is_file()]
        assert all(not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES for file in files)
        assert sum(file.stat().st_size for file in files) <= 64 * 1024 * 1024
        save(evidence / 'artifact-manifest.json', {str(file.relative_to(evidence)): digest(file) for file in files})
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'candidateGreenVerified', 'lifecycleLedgerVerified']}))
sys.exit(0 if receipt['passed'] else 1)
