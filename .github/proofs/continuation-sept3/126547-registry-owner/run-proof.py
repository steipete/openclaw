"""Disabled single-owner RED/GREEN proof; every executed source and regression contract must be reviewed."""
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
receipt = {'schema': 'openclaw-126547-registry-owner-v1', 'passed': False,
           'diagnosticComplete': False, 'phase': 'setup', 'lane': lane,
           'comparison': packet['comparison'], 'commands': [], 'groups': [],
           'unconfirmedCommandGroups': [], 'cleanupErrors': []}
TEST_PATH = 'src/gateway/server-channels.test.ts'
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
        namespaces = [scratch / label / 'tmp' for label in ['bootstrap', 'owner-regression']]
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


def verify_owner_result(result):
    data, tests, _ = parse_test_report('owner-regression', TEST_PATH)
    contract = packet['testContract']
    failures = [t for t in tests if t['status'] == 'failed']
    observed = {'path': TEST_PATH, 'tests': tests, 'exitCode': result['exitCode'],
                'jsonSHA256': digest(evidence / 'owner-regression.json'),
                'expectedRedObserved': False, 'candidateGreenObserved': False,
                'baselineProjectionIndependentlyReviewed': False}
    save(evidence / 'owner-regression-observed.json', observed)
    if lane == 'baseline':
        assert result['exitCode'] == 1 and data.get('success') is False
        assert len(failures) == data.get('numFailedTests') == 1
        assert data.get('numPassedTests') == len(tests) - 1
        assert failures[0]['fullName'] == contract['baselineFailure']['fullName']
        message = '\n'.join(failures[0].get('failureMessages', []))
        assert all(fragment in message for fragment in contract['baselineFailure']['requiredFailureFragments'])
        assert all(t['status'] == 'passed' and not t.get('failureMessages') for t in tests if t is not failures[0])
        observed['expectedRedObserved'] = True
        observed['redScope'] = 'Exact reviewed assertion failed; full actual projection remains for root artifact review'
    else:
        assert len(tests) == contract['count']
        assert sorted(t['fullName'] for t in tests) == sorted(contract['fullNames'])
        assert result['exitCode'] == 0 and data.get('success') is True
        assert not failures and data.get('numFailedTests') == 0
        assert data.get('numPassedTests') == len(tests)
        assert all(t['status'] == 'passed' and not t.get('failureMessages') for t in tests)
        observed['candidateGreenObserved'] = True
    save(evidence / 'owner-regression-verified.json', observed)
    return observed


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


try:
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    assert os_release.get('ID', '').strip(chr(34)) == 'ubuntu'
    assert os_release.get('VERSION_ID', '').strip(chr(34)) == '24.04'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-plugin-registry-owner-proof'
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
    contract = packet['testContract']
    assert contract['reviewed'] is True and contract['path'] == TEST_PATH, 'Regression contract is unbound'
    assert isinstance(contract['baselineFailure']['fullName'], str) and contract['baselineFailure']['fullName']
    if lane == 'candidate':
        assert type(contract['count']) is int and contract['count'] > 0
        assert len(contract['fullNames']) == contract['count']
        assert all(isinstance(name, str) and name for name in contract['fullNames'])
        assert contract['baselineFailure']['fullName'] in contract['fullNames']
        assert re.fullmatch(r'[a-f0-9]{64}', contract['baselineReportSHA256'] or ''), 'Observed baseline inventory is unbound'
    assert contract['baselineFailure']['requiredFailureFragments']
    assert all(isinstance(value, str) and value for value in contract['baselineFailure']['requiredFailureFragments'])
    assert re.fullmatch(r'[a-f0-9]{64}', contract['testSHA256'] or '')
    assert binding['sourceHashes'][TEST_PATH] == contract['testSHA256']
    assert set(binding['sourceHashes']) == set(binding['requiredSourcePaths'])
    assert binding['sourceHashes'] and all(re.fullmatch(r'[a-f0-9]{64}', v or '') for v in binding['sourceHashes'].values())
    assert not started_file.is_symlink() and started_file.stat().st_size <= 1024
    started = json.loads(started_file.read_text())
    assert started['runId'] == os.environ['GITHUB_RUN_ID'] and started['attempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert started['job'] == os.environ['GITHUB_JOB']
    assert binding['jobBudgetSeconds'] == 3600 and binding['cleanupAndArtifactReserveSeconds'] == 240
    elapsed = (time.monotonic_ns() - started['monotonicNs']) / 1e9
    assert 0 <= elapsed < 3600
    deadline = time.monotonic() + 3600 - 240 - elapsed
    save(evidence / 'job-budget.json', {'firstStep': started, 'controllerElapsedSeconds': elapsed,
         'jobBudgetSeconds': 3600, 'cleanupAndArtifactReserveSeconds': 240,
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
    scratch = Path(tempfile.mkdtemp(prefix='p126547-owner-', dir='/tmp')).resolve()
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
    runtime = runtime_env('owner-regression')
    runtime.update(cache_env)
    argv = [node, 'scripts/run-vitest.mjs', 'run', TEST_PATH,
            '--reporter=verbose', '--reporter=github-actions', '--reporter=json',
            '--outputFile=' + str(evidence / 'owner-regression.json')]
    save(evidence / 'execution-policy.json', {'argv': argv, 'parentEnv': runtime,
         'testPath': TEST_PATH, 'sourceOverlay': False, 'standaloneBuild': False,
         'cacheConfiguredBeforeInstall': True, 'cacheRestored': False,
         'reporting': 'Preserve verbose/github-actions and add the existing native JSON end-of-run report',
         'timeoutsRetriesWorkers': 'Native run-vitest/test-projects owner; no caller overrides'})
    before = canonical_closure_snapshot('before-owner-regression')
    assert not before['compiledWorkerDirectories'] and not before['retainedResourceOwners'] and not before['retainedArtifactClaims']
    receipt['nativeClosureVerified'] = False
    source_guard('before-owner-regression')
    try:
        result = budgeted_run('owner-regression', argv, runtime, diagnostic=True)
    finally:
        source_guard('after-owner-regression')
    text = '\n'.join((evidence / ('owner-regression.' + suffix)).read_text(errors='replace') for suffix in ['stdout', 'stderr'])
    receipt['nativeClosure'] = verify_native_closure('after-owner-regression', text)
    receipt['nativeClosureVerified'] = True
    observed = verify_owner_result(result)
    receipt['diagnosticComplete'] = True
    receipt.update(passed=observed['candidateGreenObserved'], phase='complete',
                   expectedRedObserved=observed['expectedRedObserved'],
                   candidateGreenObserved=observed['candidateGreenObserved'])
    # A proven regression is still an ordinary failed test/job; only GREEN exits zero.
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
