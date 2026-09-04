"""Reviewed baseline-only hosted proof. No candidate implementation is admitted."""
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
receipt = {'schema': 'openclaw-137313-baseline-hosted-v1', 'passed': False, 'phase': 'setup',
           'baselineRedVerified': False, 'nativeLedgerVerified': False, 'regressionStarted': False,
           'commands': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': []}
scratch = node = installed_lock = initial_guard = None
overlay_identities = {}
original_tests = {}
manifest = manifest_bytes = None
MAX_LOG_BYTES = 16 * 1024 * 1024
index_observations = []
index_capture_bytes = {}
TEST_PATHS = [
    'extensions/discord/src/monitor/message-handler.process.session-routing.test.ts',
    'extensions/discord/src/monitor/message-handler.context.test.ts',
]
OVERLAY_PATHS = [
    'extensions/discord/src/monitor/message-handler.process.session-routing.test.ts',
    'extensions/discord/src/monitor/message-handler.process.test-harness.ts',
    'extensions/discord/src/monitor/message-handler.context.test.ts',
]
TEST_CONFIG = 'test/vitest/vitest.extension-discord.config.ts'
overlays = {entry['path']: entry for entry in binding['overlays']}

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
    assert git_text('rev-parse', 'HEAD') == binding['baseHead']
    assert git_text('rev-parse', 'HEAD^{tree}') == binding['baseTree']
    assert git_text('remote', 'get-url', 'origin') == 'https://github.com/openclaw/openclaw'
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
    save(evidence / 'tracked-baseline.json', {'index': index, 'tracked': snapshot})
    return {'index': index, 'tracked': snapshot, 'names': names}


def source_guard(label):
    index, _ = index_facts()
    expected = dict(initial_guard['tracked'])
    for name in overlay_identities:
        expected[name] = {'kind': 'file', 'sha256': overlays[name]['overlaySha256']}
    observed = {'head': git_text('rev-parse', 'HEAD'), 'tree': git_text('rev-parse', 'HEAD^{tree}'),
                'index': index, 'testOverlays': sorted(overlay_identities), 'trackedCount': len(expected)}
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
    assert observed['head'] == binding['baseHead'] and observed['tree'] == binding['baseTree']
    assert observed['indexUnchanged'], 'Index changed'
    assert not changes, changes
    assert git_changes == sorted(overlay_identities), git_changes
    if installed_lock is not None:
        assert current_lock == installed_lock, 'Installed frozen lock changed'
        verify_dependencies()
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


def parse_test_report(name):
    file = evidence / (name + '.json')
    assert file.is_file() and not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES
    data = json.loads(file.read_text())
    files = data.get('testResults', [])
    expected_paths = {str(checkout / p): p for p in TEST_PATHS}
    assert len(files) == 2 and {f['name'] for f in files} == set(expected_paths), 'Wrong collected files'
    tests = []
    for result in files:
        target = expected_paths[result['name']]
        spec = binding['expectedFiles'][target]
        assert not result.get('message'), 'Module/hook error is not a regression'
        rows = result.get('assertionResults', [])
        assert len(rows) == spec['total']
        assert sorted(t['fullName'] for t in rows) == sorted(spec['fullNames'])
        assert sum(t['status'] == 'passed' for t in rows) == spec['passed']
        assert result['status'] == ('failed' if spec['passed'] < spec['total'] else 'passed')
        tests.extend(rows)
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


def parse_red():
    data, tests, clean = parse_test_report('baseline-discord')
    expected = binding['expectedFailures']
    assert data.get('success') is False
    assert len(tests) == binding['expectedTotalTests']
    assert data.get('numPassedTests') == binding['expectedPassedTests']
    assert data.get('numFailedTests') == len(expected)
    assert sorted(t['fullName'] for t in tests) == sorted(binding['expectedFullNames'])
    assert all(t['status'] in {'passed', 'failed'} for t in tests)
    failed = [t for t in tests if t['status'] == 'failed']
    assert {t['fullName'] for t in failed} == set(expected)
    assert all(not t.get('failureMessages') for t in tests if t['status'] == 'passed')
    blocks = {}
    lines = clean.splitlines()
    for test in failed:
        spec = expected[test['fullName']]
        messages = test.get('failureMessages', [])
        assert len(messages) == 1, 'Additional assertion/hook failure attached to intended RED'
        errors = messages[0]
        assert 'AssertionError' in errors and spec['assertionMessage'] in errors
        target = spec['path']
        assert target in TEST_PATHS
        source_lines = (checkout / target).read_text().splitlines()
        locations = spec['assertionLocations']
        assert len(locations) == 2 and len({x['line'] for x in locations}) == 2
        assert locations == [
            {'line': 793, 'source': json.dumps(spec['assertionMessage']) + ','},
            {'line': 794, 'source': ').toEqual({ agentText: expectedAgentText, BodyForAgent: expectedAgentText });'},
        ]
        for location in locations:
            assert source_lines[location['line'] - 1].strip() == location['source']
        message_location = spec['messageLocation']
        assert source_lines[message_location['line'] - 1].strip() == message_location['source']
        assert spec['assertionMessage'] in message_location['source']
        assert any(re.search(re.escape(target) + ':' + str(x['line']) + r':\d+', errors) for x in locations)
        chain = ' > '.join([*test['ancestorTitles'], test['title']])
        heading = re.compile(r'\s*FAIL\s+.*?' + re.escape(target) + r'\s+>\s+' + re.escape(chain) + r'\s*')
        starts = [i for i, line in enumerate(lines) if heading.fullmatch(line)]
        assert len(starts) == 1, 'Missing/duplicate exact failure block'
        ends = [i for i in range(starts[0] + 1, len(lines)) if re.fullmatch(r'\s*⎯+\[\d+/' + str(len(failed)) + r'\]⎯+\s*', lines[i])]
        assert ends, 'Missing failure block delimiter'
        block = '\n'.join(lines[starts[0]:ends[0] + 1])
        assert spec['failureBodyFragments'] and all(v in block for v in spec['failureBodyFragments'])
        # The stack and custom message identify the intended final equality.
        # Signed diff lines distinguish an empty received projection from another mismatch.
        for key in ['agentText', 'BodyForAgent']:
            assert re.search(r'^\+\s+"' + key + r'": "",?\s*$', block, re.M), 'Received projection was not empty'
        assert re.search(r'^-.*\[Forwarded message\]', block, re.M)
        assert re.search(r'^-.*?/status forwarded task content <@900000000000000003>', block, re.M)
        blocks[test['fullName']] = block
    save(evidence / 'expected-red-blocks.json', blocks)
    save(evidence / 'baseline-red.json', {'tests': tests, 'jsonSHA256': digest(evidence / 'baseline-discord.json'),
                                        'expectedFailureCount': len(failed)})

def replace_test(name, expected_bytes, replacement, identity=None):
    assert name in OVERLAY_PATHS
    test_path = checkout / name
    assert test_path.parent.resolve() == checkout / 'extensions/discord/src/monitor'
    descriptor = os.open(test_path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'r+b') as file:
        metadata = os.fstat(file.fileno())
        current_identity = (metadata.st_dev, metadata.st_ino)
        if identity is not None:
            assert current_identity == identity, 'Overlay inode was replaced'
        assert file.read() == expected_bytes, 'Overlay content was replaced'
        file.seek(0)
        file.write(replacement)
        file.truncate()
        file.flush()
        os.fsync(file.fileno())
    return current_identity


def verify_dependencies():
    modules = (checkout / 'node_modules').resolve()
    assert modules.is_relative_to(checkout)
    observations = []
    for entry in binding['dependencyFiles']:
        target = checkout / entry['path']
        assert not Path(entry['path']).is_absolute() and '..' not in Path(entry['path']).parts
        resolved = target.resolve()
        contained = resolved.is_relative_to(modules)
        is_file = target.is_file() if contained else None
        observed = {
            'name': entry['name'], 'path': entry['path'],
            'resolvedPath': str(resolved.relative_to(checkout)) if resolved.is_relative_to(checkout) else None,
            'withinModules': contained, 'isFile': is_file,
            'sha256': digest(target) if is_file else None, 'expectedSHA256': entry['sha256'],
        }
        observations.append(observed)
        save(evidence / 'dependency-contract-observations.json', {
            'phase': receipt['phase'], 'entries': observations,
        })
        assert contained, 'Dependency escaped installed modules: ' + entry['name']
        assert is_file and observed['sha256'] == entry['sha256'], 'Dependency contract changed: ' + entry['name']


def verify_native_ledgers():
    contract = binding['ledgerContract']
    assert contract['reviewed'] is True
    console = strip_ansi((evidence / 'baseline-discord.stdout').read_text(errors='replace'))
    marker = contract['stdoutPrefix']
    assert marker == 'PROOF_137313_NATIVE:'
    rows = [json.loads(line[len(marker):]) for line in console.splitlines() if line.startswith(marker)]
    scenarios = contract['scenarios']
    assert len(rows) == len(scenarios) == 5, 'Missing/duplicate native receipts'
    assert [r['scenario'] for r in rows] == [s['name'] for s in scenarios], 'Receipt order or identity changed'
    for row, scenario in zip(rows, scenarios, strict=True):
        forward, reply, drop = [scenario[k] for k in ['forward', 'reply', 'requireMention']]
        content = '' if forward else contract['ordinaryText']
        channel_id = scenario['channelId']
        expected_keys = {'scenario', 'rawContent', 'topLevelMentionCount', 'observation',
                         'dispatchCount', 'replyCount', 'deliveryJoined', 'processReturned',
                         'channelCacheCleared', 'runtimeErrors', 'runtimeExits', 'verboseCalls', 'restRoutes'}
        if forward:
            expected_keys.add('snapshotContent')
            assert row['snapshotContent'] == contract['forwardText']
        assert set(row) == expected_keys
        assert row['rawContent'] == content
        assert type(row['topLevelMentionCount']) is int and row['topLevelMentionCount'] == 0
        assert row['runtimeErrors'] == row['runtimeExits'] == []
        verbose = row['verboseCalls']
        limits = contract['verboseCalls']
        assert isinstance(verbose, list) and len(verbose) <= limits['maxCalls']
        assert len(json.dumps(verbose, ensure_ascii=False).encode()) <= limits['maxEncodedUTF8Bytes']
        for call in verbose:
            assert isinstance(call, list) and len(call) == limits['maxArgumentsPerCall'] == 1
            assert isinstance(call[0], str) and len(call[0].encode()) <= limits['maxArgumentUTF8Bytes']
        # Require the actual logger observation as well as the existing negative
        # outcome assertion. Admission cannot be inferred from a null result alone.
        mention_drop_observed = [limits['mentionDropMessage']] in verbose
        assert mention_drop_observed is drop, 'Observed mention-drop log disagrees with admission'
        assert row['channelCacheCleared'] is True
        expected_routes = ([f'/channels/{channel_id}/messages/{channel_id}1'] if forward else [])
        expected_routes.append(f'/channels/{channel_id}')
        assert row['restRoutes'] == expected_routes
        count = 0 if drop else 1
        assert type(row['dispatchCount']) is int and row['dispatchCount'] == count
        assert type(row['replyCount']) is int and row['replyCount'] == count
        assert row['deliveryJoined'] is (not drop) and row['processReturned'] is (not drop)
        if drop:
            assert row['observation'] == {'admitted': False, 'dropLogged': True}
        else:
            # Baseline-only: the two forwarded projections must be empty, while
            # messageText retains the exact snapshot and intent remains raw sender text.
            observation = {
                'admitted': True, 'baseText': content,
                'messageText': contract['forwardAgentText'] if forward else content,
                'agentText': '' if forward else content, 'BodyForAgent': '' if forward else content,
                'RawBody': content, 'CommandBody': content,
                'CommandTurn': {'kind': 'normal', 'source': 'message', 'authorized': False, 'body': content},
                'WasMentioned': False,
            }
            if reply:
                observation['ReplyToBody'] = contract['ordinaryReplyText']
            assert row['observation'] == observation, 'Native projection or authority differed: ' + scenario['name']
    save(evidence / 'native-ledgers.json', rows)
    save(evidence / 'native-ledgers-verified.json', {
        'scenarios': [s['name'] for s in scenarios], 'admitted': 4, 'mentionDropped': 1,
        'joinedReplies': 4, 'preciseEmptyForwardedProjections': 2,
        'rawCommandAndMentionAuthorityPreserved': True, 'restRoutesVerified': True,
        'runtimeErrors': 0, 'runtimeExits': 0, 'channelCacheEntriesCleared': 5,
        'verboseCalls': {'counts': [len(row['verboseCalls']) for row in rows],
                         'bounded': True, 'negativeMentionDropObserved': True},
        'cleanupLimit': contract['cleanupLimit'],
    })
    return digest(evidence / 'native-ledgers.json')


try:
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-discord-forward-baseline-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'baseline'
    assert binding['runnable'] is True and binding['candidateMayRun'] is False, 'Baseline packet is not sealed'
    assert binding['baseHead'] == 'd2a616bdf373a5b3cac0add8e9b2f70cd0802f42'
    assert re.fullmatch(r'[a-f0-9]{40}', binding['baseTree'])
    assert len(overlays) == len(binding['overlays']) == 3 and set(overlays) == set(OVERLAY_PATHS)
    assert binding['overlayPaths'] == OVERLAY_PATHS and set(TEST_PATHS) < set(OVERLAY_PATHS)
    assert all(re.fullmatch(r'[a-f0-9]{64}', e['overlaySha256']) for e in overlays.values())
    assert binding['nodeVersion'] == '24.19.0'
    assert binding['testPaths'] == TEST_PATHS and binding['testConfig'] == TEST_CONFIG
    assert binding['expectedTotalTests'] == len(binding['expectedFullNames'])
    assert binding['expectedPassedTests'] > 0 and binding['expectedFailures']
    assert binding['expectedTotalTests'] == binding['expectedPassedTests'] + len(binding['expectedFailures'])
    assert set(binding['sourceHashes']) == set(binding['requiredSourcePaths'])
    assert set(OVERLAY_PATHS + ['package.json', 'pnpm-lock.yaml', 'scripts/run-vitest.mjs']).issubset(binding['sourceHashes'])
    assert binding['ledgerContract']['reviewed'] is True
    assert binding['ledgerContract']['verboseCalls'] == {
        'maxCalls': 64, 'maxArgumentsPerCall': 1, 'maxArgumentUTF8Bytes': 4096,
        'maxEncodedUTF8Bytes': 65536,
        'mentionDropMessage': 'discord: drop guild message (mention required, botId=900000000000000003)',
        'source': 'Observed logVerboseForTest.mock.calls, reset by the existing per-test lifecycle; no synthetic success markers or substituted logger behavior.',
    }
    manifest_bytes = (assets / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest.get('incomplete') is False, 'Publication asset manifest is incomplete'
    assert git_text('rev-parse', 'HEAD', cwd=proof_root) == os.environ['GITHUB_SHA']
    verify_no_checkout_credentials(proof_root)
    verify_no_checkout_credentials(checkout)
    verify_assets()
    for entry in overlays.values():
        assert digest(assets / entry['artifact']) == entry['overlaySha256']
    assert binding['buildPolicy']['separateFullBuild'] is False
    save(evidence / 'git-toolchain.json', {'version': git_text('--version'),
         'executableSHA256': digest('/usr/bin/git'), 'optionalLocks': '0',
         'porcelainDiffIndex': 'exact disposable copy; real index remains guarded'})
    initial_guard = capture_source()
    assert not (checkout / 'node_modules').exists()
    for name in OVERLAY_PATHS:
        assert not (checkout / name).is_symlink()
        original_tests[name] = (checkout / name).read_bytes()
        assert sha(original_tests[name]) == overlays[name]['baselineSha256'] == binding['sourceHashes'][name]
    node = str(Path(shutil.which('node')).resolve())
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file() and corepack.resolve().is_relative_to(Path(node).parent.parent)
    scratch = Path(tempfile.mkdtemp(prefix='p137313-', dir='/tmp')).resolve()
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
    verify_dependencies()
    save(evidence / 'dependency-contracts.json', binding['dependencyFiles'])
    save(evidence / 'build-prerequisite-decision.json', binding['buildPolicy'])
    source_guard('before-overlay')
    for name in OVERLAY_PATHS:
        entry = overlays[name]
        overlay_identities[name] = replace_test(name, original_tests[name], (assets / entry['artifact']).read_bytes())
    save(evidence / 'overlays.json', [
        {'path': name, 'baselineSHA256': sha(original_tests[name]),
         'overlaySHA256': overlays[name]['overlaySha256'],
         'device': identity[0], 'inode': identity[1]}
        for name, identity in overlay_identities.items()
    ])
    source_guard('overlays-installed')
    receipt['regressionStarted'] = True
    try:
        run('baseline-discord', [node, 'scripts/run-vitest.mjs', 'run', '--config', TEST_CONFIG,
            *TEST_PATHS, '--reporter=verbose', '--reporter=json',
            '--outputFile=' + str(evidence / 'baseline-discord.json')], runtime_env('discord'), 1800, exits=(1,))
    finally:
        source_guard('tested-before-parser')
    parse_red()
    receipt['nativeLedgerSHA256'] = verify_native_ledgers()
    receipt['nativeLedgerVerified'] = True
    receipt.update(passed=True, phase='complete', baselineRedVerified=True)
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if initial_guard is not None:
            source_guard('before-cleanup')
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        assert not receipt['regressionStarted'] or (
            receipt['baselineRedVerified'] and receipt['nativeLedgerVerified']
        ), 'Regression or its native receipt incomplete; retain overlays/runtime'
        for name in list(overlay_identities)[::-1]:
            replace_test(name, (assets / overlays[name]['artifact']).read_bytes(),
                         original_tests[name], overlay_identities[name])
            del overlay_identities[name]
        receipt['overlaysRestored'] = True
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
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'baselineRedVerified', 'nativeLedgerVerified']}))
sys.exit(0 if receipt['passed'] else 1)
