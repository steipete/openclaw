"""Hosted proof for the reviewed immutable Discord candidate."""
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
receipt = {'schema': 'openclaw-137313-candidate-hosted-v1', 'passed': False, 'phase': 'setup',
           'candidateGreenVerified': False, 'docsListVerified': False, 'nativeLedgerVerified': False, 'candidateStarted': False,
           'commands': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': []}
scratch = node = installed_lock = initial_guard = None
manifest = manifest_bytes = None
MAX_LOG_BYTES = 16 * 1024 * 1024
index_observations = []
index_capture_bytes = {}
TARGET_TEST_PATHS = [
    'extensions/discord/src/monitor/message-handler.process.session-routing.test.ts',
    'extensions/discord/src/monitor/message-handler.context.test.ts',
]
ADDITIONAL_TEST_PATHS = [
    'extensions/discord/src/monitor/message-handler.process.abort-retry.test.ts',
    'extensions/discord/src/monitor/message-handler.process.abort-skip.test.ts',
    'extensions/discord/src/monitor/message-handler.process.ack.test.ts',
    'extensions/discord/src/monitor/message-handler.process.draft-final.test.ts',
    'extensions/discord/src/monitor/message-handler.process.draft-progress.test.ts',
    'extensions/discord/src/monitor/message-handler.process.draft-reasoning.test.ts',
    'extensions/discord/src/monitor/message-handler.process.draft-recovery.test.ts',
    'extensions/discord/src/monitor/message-handler.process.room-events.test.ts',
]
TEST_PATHS = TARGET_TEST_PATHS + ADDITIONAL_TEST_PATHS
TEST_CONFIG = 'test/vitest/vitest.extension-discord.config.ts'

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
                'index': index, 'trackedCount': len(expected)}
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
    assert len(files) == 10 and {f['name'] for f in files} == set(expected_paths), 'Wrong collected files'
    tests, target_tests, additional_tests = [], [], []
    verified_files = []
    for result in files:
        target = expected_paths[result['name']]
        assert not result.get('message'), 'Module/hook error is not proof'
        rows = result.get('assertionResults', [])
        assert rows and all(t['status'] == 'passed' and not t.get('failureMessages') for t in rows)
        assert result['status'] == 'passed'
        if target in TARGET_TEST_PATHS:
            spec = binding['expectedFiles'][target]
            assert len(rows) == spec['total'] == spec['passed']
            assert sorted(t['fullName'] for t in rows) == sorted(spec['fullNames'])
            target_tests.extend(rows)
        else:
            assert target in ADDITIONAL_TEST_PATHS
            additional_tests.extend(rows)
        tests.extend(rows)
        verified_files.append({'path': target, 'passed': len(rows), 'target': target in TARGET_TEST_PATHS})
    assert len(target_tests) == binding['expectedTargetTests'] == 33
    assert sorted(t['fullName'] for t in target_tests) == sorted(binding['expectedTargetFullNames'])
    assert len(additional_tests) >= binding['expectedAdditionalMinimumTests'] == 8
    assert data.get('success') is True
    assert data.get('numTotalTests') == data.get('numPassedTests') == len(tests)
    assert data.get('numFailedTests') == data.get('numFailedTestSuites') == 0
    assert data.get('numPendingTests') == data.get('numTodoTests') == data.get('numPendingTestSuites') == 0
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
    save(evidence / 'candidate-tests-verified.json', {
        'targetPassed': len(target_tests), 'additionalPassed': len(additional_tests),
        'totalPassed': len(tests), 'files': verified_files,
        'jsonSHA256': digest(file),
    })
    return data, tests, clean


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
    console = strip_ansi((evidence / 'candidate-discord.stdout').read_text(errors='replace'))
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
            # The repaired owner passes composed text to the agent, while
            # command and mention authority remain the sender's raw input.
            observation = {
                'admitted': True, 'baseText': content,
                'messageText': contract['forwardAgentText'] if forward else content,
                'agentText': contract['forwardAgentText'] if forward else content,
                'BodyForAgent': contract['forwardAgentText'] if forward else content,
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
        'joinedReplies': 4, 'completeForwardedProjections': 2,
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
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-discord-forward-candidate-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'candidate'
    assert binding['runnable'] is True and binding['candidateMayRun'] is True, 'Candidate packet is not bound'
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateHead'])
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateTree'])
    assert binding['candidateHead'] != '0' * 40 and binding['candidateTree'] != '0' * 40
    assert binding['candidateRepository'] == 'steipete/openclaw'
    assert binding['pendingSourcePaths'] == []
    assert binding['nodeVersion'] == '24.19.0'
    assert binding['testPaths'] == TEST_PATHS and binding['testConfig'] == TEST_CONFIG
    assert binding['targetTestPaths'] == TARGET_TEST_PATHS and binding['additionalTestPaths'] == ADDITIONAL_TEST_PATHS
    assert binding['expectedTargetTests'] == len(binding['expectedTargetFullNames']) == 33
    assert len(binding['committedFixtures']) == 3
    assert set(binding['sourceHashes']) == set(binding['requiredSourcePaths'])
    assert set(TEST_PATHS + ['package.json', 'pnpm-lock.yaml', 'scripts/run-vitest.mjs']).issubset(binding['sourceHashes'])
    assert all(re.fullmatch(r'[a-f0-9]{64}', value) for value in binding['sourceHashes'].values())
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
    for entry in binding['committedFixtures']:
        assert digest(assets / entry['artifact']) == entry['sha256'] == binding['sourceHashes'][entry['path']]
    assert binding['buildPolicy']['separateFullBuild'] is False
    save(evidence / 'git-toolchain.json', {'version': git_text('--version'),
         'executableSHA256': digest('/usr/bin/git'), 'optionalLocks': '0',
         'porcelainDiffIndex': 'exact disposable copy; real index remains guarded'})
    initial_guard = capture_source()
    assert not (checkout / 'node_modules').exists()
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
    source_guard('before-docs-list')
    assert binding['documentationProof'] == {
        'command': ['pnpm', 'docs:list'], 'packageScript': 'node scripts/docs-list.js',
        'owner': 'scripts/docs-list.js', 'requiredDoc': 'docs/channels/discord.md',
        'runtimeImports': ['node:fs', 'node:path', 'node:url'],
        'scope': 'Canonical source-doc metadata listing, not a docs build or full markdown lint.',
    }
    assert json.loads((checkout / 'package.json').read_text())['scripts']['docs:list'] == 'node scripts/docs-list.js'
    try:
        run('docs-list', [pnpm, 'docs:list'], runtime_env('docs-list'), 300)
    finally:
        source_guard('docs-listed')
    docs_output = strip_ansi((evidence / 'docs-list.stdout').read_text(errors='replace'))
    assert 'Listing all markdown files in docs folder:' in docs_output
    assert re.search(r'^channels/discord\.md - \S', docs_output, re.M), 'Discord docs metadata absent'
    save(evidence / 'docs-list-verified.json', {
        'command': binding['documentationProof']['command'],
        'packageScript': binding['documentationProof']['packageScript'],
        'sourceOwnerSHA256': digest(checkout / 'scripts/docs-list.js'),
        'discordDocSHA256': digest(checkout / 'docs/channels/discord.md'),
        'stdoutSHA256': digest(evidence / 'docs-list.stdout'),
        'requiredDocListed': True, 'exitCode': 0,
        'scope': binding['documentationProof']['scope'],
    })
    receipt['docsListVerified'] = True
    source_guard('before-tests')
    receipt['candidateStarted'] = True
    try:
        run('candidate-discord', [node, 'scripts/run-vitest.mjs', 'run', '--config', TEST_CONFIG,
            *TEST_PATHS, '--reporter=verbose', '--reporter=json',
            '--outputFile=' + str(evidence / 'candidate-discord.json')], runtime_env('discord'), 1800)
    finally:
        source_guard('tested-before-parser')
    parse_test_report('candidate-discord')
    receipt['nativeLedgerSHA256'] = verify_native_ledgers()
    receipt['nativeLedgerVerified'] = True
    assert receipt['docsListVerified'] is True
    receipt.update(passed=True, phase='complete', candidateGreenVerified=True)
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if initial_guard is not None:
            source_guard('before-cleanup')
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        assert not receipt['candidateStarted'] or (
            receipt['candidateGreenVerified'] and receipt['nativeLedgerVerified']
        ), 'Candidate tests or native receipts incomplete; retain private runtime'
        if initial_guard is not None:
            source_guard('final')
            receipt['committedSourceUnmodified'] = True
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
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'candidateGreenVerified', 'nativeLedgerVerified', 'docsListVerified']}))
sys.exit(0 if receipt['passed'] else 1)
