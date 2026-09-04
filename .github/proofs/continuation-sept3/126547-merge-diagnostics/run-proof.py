"""Exact candidate core/plugin stripe-1 lint diagnostics. No original CI checkout attribution."""
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
checkout, evidence = [Path(value).resolve() for value in sys.argv[1:3]]
lane = sys.argv[3]
assert lane == 'candidate'
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
packet = json.loads((assets / 'execution-binding.json').read_text())
binding = {**packet, **packet['lanes'][lane]}
proof_root = assets.parents[3]
receipt = {'schema': 'openclaw-126547-merge-diagnostics-v1', 'passed': False, 'phase': 'setup',
           'lane': lane, 'diagnosticOnly': True, 'comparison': packet['comparison'], 'allChecksExecuted': False,
           'commands': [], 'checks': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': []}
scratch = node = installed_lock = initial_guard = None
manifest = manifest_bytes = None
MAX_LOG_BYTES = 16 * 1024 * 1024
index_observations = []
index_capture_bytes = {}
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


def verify_canonical_closure(name):
    # Artifact owners retain these records on unjoined detached children. Never remove them.
    owner = checkout / '.artifacts/dist-artifacts.lock'
    assert not owner.is_symlink(), 'Unexpected symlink at canonical artifact lock'
    entries = sorted(child.name for child in owner.iterdir()) if owner.is_dir() else []
    retained = [value for value in entries if value == 'owner.json' or value == 'unjoined' or value.startswith('child-')]
    text = '\n'.join((evidence / (name + '.' + suffix)).read_text(errors='replace') for suffix in ['stdout', 'stderr'])
    markers = [value for value in [
        'EPROCESSGROUP_CLEANUP_FAILED', '[dist artifacts] child cleanup unverified; retained ',
        'Managed command cleanup could not verify child, process group, and output closure',
        'sibling cleanup could not be verified',
    ] if value in text]
    # Knip's timeout/buffer branch attempts cleanup without a final positive join.
    # Stop this diagnostic lane on that branch; a normal findings exit is allowed.
    knip_incomplete = re.findall(r'\[deadcode\] Knip [^\n]+ (?:timed out after|exceeded) [^\n]+; terminating\.', text)
    facts = {'canonicalArtifactOwnerEntries': entries, 'retainedClaims': retained,
             'cleanupFailureMarkers': markers, 'knipIncompleteCleanupBranches': knip_incomplete,
             'scope': 'canonical owner retention and failure reports; outer group is checked independently'}
    save(evidence / (name + '-closure.json'), facts)
    if retained or markers or knip_incomplete:
        receipt['unconfirmedCommandGroups'].append(name + '/canonical-cleanup')
        raise AssertionError(name + ': canonical process closure unconfirmed')
    return facts


def diagnostic_check(case, timeout=None):
    name = case['name']
    row = {'name': name, 'status': 'incomplete', 'source': case['source'], 'env': case['env']}
    receipt['checks'].append(row)
    argv = [node if case['argv'][0] == 'node' else pnpm, *case['argv'][1:]]
    env = {**runtime_env(name), **case['env']}
    try:
        try:
            result = run(name, argv, env, case['timeoutSeconds'] if timeout is None else timeout, diagnostic=True)
            row.update(status=result['status'], commandStatus=result['status'], exitCode=result['exitCode'], commandResult=name + '-result.json')
        finally:
            # Save all integrity observations before any diagnostic interpretation.
            source_guard(name)
        row['closure'] = verify_canonical_closure(name)
        row['sourceGuardVerified'] = True
    except Exception as error:
        row.update(status='incomplete', error=str(error))
        raise
    finally:
        save(evidence / (name + '-verdict.json'), row)


try:
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    assert os_release.get('ID', '').strip(chr(34)) == 'ubuntu'
    assert os_release.get('VERSION_ID', '').strip(chr(34)) == '24.04'
    save(evidence / 'hosted-platform.json', {'osRelease': os_release, 'machine': platform.machine(),
         'logicalCpuCount': os.cpu_count(), 'physicalMemoryBytes': os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')})
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-plugin-reload-merge-diagnostics'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'source'
    assert binding['runnable'] is True and binding['executionMayRun'] is True, 'Diagnostic packet is disabled'
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateHead'] or '')
    assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', binding['candidateRepository'] or '')
    assert re.fullmatch(r'[a-f0-9]{40}', binding['candidateTree'] or '')
    assert binding['nodeVersion'] == '24.19.0'
    assert binding['candidateRepository'] == 'steipete/openclaw'
    assert packet['comparison']['originalFailedCiCheckoutProven'] is False
    assert set(packet['lanes']) == {'candidate'}
    assert packet['comparison']['candidateHead'] == binding['candidateHead']
    assert packet['comparison']['candidateTree'] == binding['candidateTree']
    assert packet['comparison']['parents'] == binding['parents']
    assert [group['order'] for group in binding['checkGroups']] == [
        ['core-lint-1', 'extension-lint-1'],
    ]
    assert all(group['timeoutSeconds'] == 900 and group['shortCircuit'] is True for group in binding['checkGroups'])
    assert set(binding['sourceHashes']) == set(binding['requiredSourcePaths'])
    assert not binding['absentSourcePaths']
    assert [case['name'] for case in binding['commands']] == [
        'core-lint-1', 'extension-lint-1',
    ]
    assert all(case['timeoutSeconds'] == 900 for case in binding['commands'])
    assert {'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml',
            'scripts/run-oxlint-shards.mts', 'scripts/run-oxlint.mts',
            'scripts/lib/local-check-runtime.mts', 'scripts/lib/managed-child-process.mts',
            'scripts/lib/dist-artifact-ownership.mts', 'config/tsconfig/oxlint.core.json',
            'extensions/tsconfig.json', '.oxlintrc.json'}.issubset(binding['sourceHashes'])
    manifest_bytes = (assets / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest.get('incomplete') is False, 'Publication asset manifest is incomplete'
    assert git_text('rev-parse', 'HEAD', cwd=proof_root) == os.environ['GITHUB_SHA']
    verify_no_checkout_credentials(proof_root)
    verify_no_checkout_credentials(checkout)
    verify_assets()
    assert all(re.fullmatch(r'[a-f0-9]{64}', value or '') for value in binding['sourceHashes'].values())
    save(evidence / 'git-toolchain.json', {'version': git_text('--version'),
         'executableSHA256': digest('/usr/bin/git'), 'optionalLocks': '0',
         'porcelainDiffIndex': 'exact disposable copy; real index remains guarded'})
    initial_guard = capture_source()
    # Read raw commit headers: shallow checkout revision walks may omit parents.
    commit_header = git('cat-file', 'commit', 'HEAD').split(b'\n\n', 1)[0].decode()
    parents = [line[7:] for line in commit_header.splitlines() if line.startswith('parent ')]
    assert parents == binding['parents'], 'Exact commit parent provenance changed'
    save(evidence / 'commit-provenance.json', {'head': binding['candidateHead'],
         'tree': binding['candidateTree'], 'parents': parents, 'comparison': packet['comparison']})
    assert not (checkout / 'node_modules').exists()
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
    # Preserve the hosted job's core-to-plugin set -e barrier with separate receipts.
    commands = {case['name']: case for case in binding['commands']}
    for group in binding['checkGroups']:
        group_started = time.monotonic()
        group_deadline = group_started + group['timeoutSeconds']
        first_result = len(receipt['checks'])
        prerequisite = None
        for name in group['order']:
            remaining = group_deadline - time.monotonic()
            blocked = prerequisite is not None and receipt['checks'][-1]['status'] != 'passed'
            if blocked or remaining <= 0:
                row = {'name': name, 'status': 'not-run', 'prerequisite': prerequisite,
                       'reason': 'prior_stripe_failed' if blocked else 'check_group_deadline_exhausted'}
                receipt['checks'].append(row)
                save(evidence / (name + '-verdict.json'), row)
            else:
                diagnostic_check(commands[name], timeout=remaining)
            prerequisite = name
        save(evidence / (group['name'] + '-result.json'), {'upstreamJob': group['upstreamJob'],
             'order': group['order'], 'timeoutSeconds': group['timeoutSeconds'],
             'elapsedSeconds': round(time.monotonic() - group_started, 3),
             'checks': receipt['checks'][first_result:]})
    receipt['allChecksExecuted'] = all(row['status'] in {'passed', 'failed'} for row in receipt['checks'])
    receipt.update(passed=all(row['status'] == 'passed' for row in receipt['checks']), phase='complete')


except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if initial_guard is not None:
            source_guard('before-cleanup')
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        if initial_guard is not None:
            source_guard('final')
        if scratch is not None:
            shutil.rmtree(scratch)
        receipt['ownedScratchRemoved'] = True
    except Exception as error:
        receipt['ownedScratchRemoved'] = False
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    for case in binding['commands']:
        if not any(row['name'] == case['name'] for row in receipt['checks']):
            row = {'name': case['name'], 'status': 'not-run', 'reason': 'Prior setup, source or process-closure gate stopped this lane'}
            receipt['checks'].append(row)
            save(evidence / (case['name'] + '-verdict.json'), row)
    # Only task-scoped check logs/reports/hashes enter evidence, never runtime HOME.
    try:
        files = [file for file in evidence.rglob('*') if file.is_file()]
        assert all(not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES for file in files)
        assert sum(file.stat().st_size for file in files) <= 64 * 1024 * 1024
        save(evidence / 'artifact-manifest.json', {str(file.relative_to(evidence)): digest(file) for file in files})
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'lane', 'allChecksExecuted']}))
sys.exit(0 if receipt['passed'] else 1)
