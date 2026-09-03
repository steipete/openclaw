"""Baseline-only Nextcloud proof; run only on the reviewed secretless hosted workflow."""
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
receipt = {'schema': 'openclaw-134817-baseline-hosted-v1', 'passed': False, 'phase': 'setup',
           'baselineRed': False, 'gatewayBaselinePassed': False, 'candidateStarted': False,
           'commands': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': []}
scratch = node = installed_lock = initial_guard = original_test = None
gateway_started = False
proof_created = False
assert binding['testPath'] == 'extensions/nextcloud-talk/src/inbound.behavior.test.ts'
assert binding['proofPath'] == 'extensions/qa-lab/src/nextcloud-commands.gateway-proof.mjs'
test_path = checkout / binding['testPath']
proof_path = checkout / binding['proofPath']
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


def source_guard(label, overlay):
    index, _ = index_facts()
    expected = dict(initial_guard['tracked'])
    if overlay:
        expected[binding['testPath']] = {'kind': 'file', 'sha256': binding['testSHA256']}
    observed = {'head': git_text('rev-parse', 'HEAD'), 'tree': git_text('rev-parse', 'HEAD^{tree}'),
                'index': index, 'testOverlay': overlay, 'trackedCount': len(expected)}
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
    assert git_changes == ([binding['testPath']] if overlay else []), git_changes
    if installed_lock is not None:
        assert current_lock == installed_lock, 'Installed frozen lock changed'
    credentials = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp', '(extraheader|credential)'], cwd=checkout, capture_output=True)
    assert credentials.returncode == 1 and not credentials.stdout, 'Checkout retains credentials'
    verify_assets()
    observed['indexAfterComparisons'], _ = index_facts()
    save(evidence / ('source-' + label + '.json'), observed)
    assert observed['indexAfterComparisons'] == initial_guard['index'], 'Index changed during guard'
    return observed


def verify_assets():
    assert (assets / 'manifest.json').read_bytes() == manifest_bytes, 'Manifest changed'
    for name, expected in manifest['sha256'].items():
        target = proof_root / name
        assert not Path(name).is_absolute() and '..' not in Path(name).parts and not target.is_symlink()
        assert digest(target) == expected, name


def run(name, argv, cwd, env, directory, timeout, exits=(0,)):
    receipt['phase'] = name
    print('PROOF_PHASE:' + name, flush=True)
    result = {'name': name, 'argv': argv, 'exitCode': None, 'termination': None,
              'executionTimeoutSeconds': timeout, 'cleanupReserveSeconds': 60}
    started = time.monotonic()
    child = None
    completed = False
    try:
        with (directory / (name + '.stdout')).open('xb') as out, (directory / (name + '.stderr')).open('xb') as err:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
            while child.poll() is None:
                size = (directory / (name + '.stdout')).stat().st_size + (directory / (name + '.stderr')).stat().st_size
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
        group_empty = False
        if child is not None and result['leaderExitObserved']:
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                group_empty = True
        result['commandGroupEmpty'] = group_empty
        result['processGroupClosure'] = 'gateway-owner-receipt-required' if name == 'baseline-gateway' else 'command-group-only'
        # Detached Gateway children belong to the canonical QA owner. Non-Gateway
        # failures or a still-live command group retain the private runtime.
        if name != 'baseline-gateway' and (not completed or not group_empty):
            receipt['unconfirmedCommandGroups'].append(name)
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(directory / (name + '-result.json'), result)
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


def parse_expected_red(test_json, console):
    assert test_json.is_file() and test_json.stat().st_size <= MAX_LOG_BYTES
    data = json.loads(test_json.read_text())
    files = data.get('testResults', [])
    assert len(files) == 1 and files[0]['name'].endswith('/' + binding['testPath'])
    assert not files[0].get('message'), 'Module/hook error is not a regression'
    tests = files[0].get('assertionResults', [])
    assert data.get('numTotalTests') == len(tests) == 21
    assert data.get('numPassedTests') == 16 and data.get('numFailedTests') == 5
    assert data.get('numPendingTests') == data.get('numTodoTests') == 0 and data.get('success') is False
    assert sorted(test['title'] for test in tests) == sorted(binding['expectedTestTitles'])
    assert all(test['status'] in {'passed', 'failed'} for test in tests)
    failed = [test for test in tests if test['status'] == 'failed']
    assert {test['title'] for test in failed} == set(binding['expectedFailures'])
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', console)
    assert not re.search(r'Vitest caught [1-9]\d* unhandled errors?|\[vitest\] UNHANDLED ERRORS \(', clean)
    assert 'Some tests are still running when generating the JSON report' not in clean
    assert '[vitest] retained temporary namespace ' not in clean, 'Canonical test cleanup was not confirmed'
    blocks = {}
    lines = clean.splitlines()
    for test in failed:
        expected = binding['expectedFailures'][test['title']]
        errors = '\n'.join(test.get('failureMessages', []))
        assert 'AssertionError' in errors and re.search(re.escape(binding['testPath']) + ':' + str(expected['line']) + r':\d+', errors), test['title']
        assert expected['assertion'] in test_path.read_text().splitlines()[expected['line'] - 1]
        chain = ' > '.join([*test['ancestorTitles'], test['title']])
        heading = re.compile(r'\s*FAIL\s+.*?' + re.escape(binding['testPath']) + r'\s+>\s+' + re.escape(chain) + r'\s*')
        starts = [i for i, line in enumerate(lines) if heading.fullmatch(line)]
        assert len(starts) == 1, 'Missing/duplicate named failure block: ' + test['title']
        ends = [i for i in range(starts[0] + 1, len(lines)) if re.fullmatch(r'\s*⎯+\[\d+/5\]⎯+\s*', lines[i])]
        assert ends, 'Missing five-failure block delimiter'
        block = '\n'.join(lines[starts[0]:ends[0] + 1])
        assert all(fragment in block for fragment in expected['failureBodyFragments']), 'Failure lacks its bound owner assertion or structured command mismatch'
        blocks[test['title']] = block
    save(evidence / 'expected-red-blocks.json', blocks)
    save(evidence / 'baseline-red.json', {'testJSONSHA256': digest(test_json), 'tests': tests, 'failures': list(blocks), 'expectedFailureCount': 5})


def inventory(label, identity):
    roots = ['dist']
    if (checkout / 'dist-runtime').exists():
        roots.append('dist-runtime')
    roots += [str(item.relative_to(checkout)) for item in sorted((checkout / 'packages').glob('*/dist')) if item.is_dir()]
    files, links = {}, []
    def visit(name):
        file = checkout / name
        if file.is_symlink():
            resolved = file.resolve(strict=True)
            links.append((name, resolved))
            files[name] = {'symlink': os.readlink(file), 'resolvedRelativeTarget': os.path.relpath(resolved, checkout)}
        elif file.is_dir():
            for child in sorted(file.iterdir()):
                visit(str(child.relative_to(checkout)))
        else:
            assert file.is_file()
            files[name] = {'sha256': digest(file), 'bytes': file.stat().st_size}
    for name in roots:
        visit(name)
    data = {'head': binding['baseHead'], 'tree': binding['baseTree'], 'sourceIdentity': identity,
            'profile': 'qaRuntime', 'privateQa': True, 'roots': roots, 'files': files}
    save(evidence / 'baseline' / label, data)
    for name, resolved in links:
        assert resolved == checkout or checkout in resolved.parents, name
    for name in binding['requiredBuiltEntries']:
        assert files.get(name, {}).get('sha256'), 'Missing built entry: ' + name
    for name in ['dist/.buildstamp', 'dist/.runtime-postbuildstamp']:
        assert json.loads((checkout / name).read_text())['head'] == binding['baseHead']
    return data


try:
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-nextcloud-baseline-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'baseline'
    assert binding['runnable'] is True and binding['candidateMayRun'] is False
    assert binding['baseHead'] == '50f02ecf4410c78269d7bbda7c47d891c9666d19'
    assert git_text('rev-parse', 'HEAD', cwd=proof_root) == os.environ['GITHUB_SHA']
    manifest_bytes = (assets / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    verify_assets()
    assert digest(assets / 'gateway-proof.mjs') == binding['proofSHA256']
    assert digest(assets / 'inbound.behavior.test.ts') == binding['testSHA256']
    save(evidence / 'git-toolchain.json', {'version': git_text('--version'),
         'executableSHA256': digest('/usr/bin/git'), 'optionalLocks': '0',
         'porcelainDiffIndex': 'exact disposable copy; real index remains guarded'})
    initial_guard = capture_source()
    assert not (checkout / 'node_modules').exists()
    assert not proof_path.exists() and not proof_path.is_symlink()
    node = str(Path(shutil.which('node')).resolve())
    assert subprocess.check_output([node, '--version'], text=True).strip() == 'v24.19.0'
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file() and corepack.resolve().is_relative_to(Path(node).parent.parent)
    scratch = Path(tempfile.mkdtemp(prefix='p134817-', dir='/tmp')).resolve()
    for name in ['corepack', 'bin']:
        (scratch / name).mkdir(mode=0o700)
    environment_path = str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin'
    bootstrap = runtime_env('bootstrap')
    provenance = {key: os.environ[key] for key in ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
                  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']}
    save(evidence / 'hosted-source.json', {'binding': binding, 'hostedProvenance': provenance,
         'nodeExecutableSHA256': digest(node), 'corepackLauncherSHA256': digest(corepack.resolve()),
         'manifestSHA256': digest(assets / 'manifest.json'), 'bootstrapEnvNames': sorted(bootstrap)})
    assert json.loads((checkout / 'package.json').read_text())['packageManager'] == binding['packageManager']
    run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], scratch, bootstrap, evidence, 300)
    run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], scratch, bootstrap, evidence, 300)
    pnpm = str(scratch / 'bin/pnpm')
    run('pnpm-version', [pnpm, '--version'], scratch, bootstrap, evidence, 300)
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    run('install', [pnpm, 'install', '--frozen-lockfile'], checkout, bootstrap, evidence, 1200)
    installed_lock = digest(checkout / 'node_modules/.pnpm/lock.yaml')
    source_guard('installed', False)
    original_test = test_path.read_bytes()
    test_path.write_bytes((assets / 'inbound.behavior.test.ts').read_bytes())
    before = source_guard('test-overlay', True)
    test_env = runtime_env('tests')
    test_json = evidence / 'baseline-tests.json'
    try:
        test_result = run('baseline-tests', [node, 'scripts/run-vitest.mjs', 'run', '--config',
                          'test/vitest/vitest.extension-messaging.config.ts', binding['testPath'],
                          '--reporter=verbose', '--reporter=json', '--outputFile=' + str(test_json)],
                          checkout, test_env, evidence, 600, exits=(0, 1))
    finally:
        source_guard('tested-before-parser', True)
    assert test_result['exitCode'] == 1, 'Original regression did not fail'
    parse_expected_red(test_json, (evidence / 'baseline-tests.stdout').read_text(errors='replace') + '\n' + (evidence / 'baseline-tests.stderr').read_text(errors='replace'))
    receipt['baselineRed'] = True
    phase_dir = evidence / 'baseline'
    phase_dir.mkdir(mode=0o700)
    build_env = runtime_env('build')
    build_env.update(OPENCLAW_BUILD_PRIVATE_QA='1', OPENCLAW_BUILD_CACHE='0')
    try:
        run('baseline-build', [node, '--import', str(checkout / 'scripts/tsx.mjs'), 'scripts/build-all.mts', 'qaRuntime'], checkout, build_env, phase_dir, 1200)
    finally:
        after_build = source_guard('built', True)
    assert after_build['sourceIdentity'] == before['sourceIdentity']
    built = inventory('runtime-build.json', before['sourceIdentity'])
    assert not proof_path.exists() and not proof_path.is_symlink()
    assert subprocess.run(['/usr/bin/git', 'ls-files', '--error-unmatch', '--', binding['proofPath']], cwd=checkout, capture_output=True).returncode == 1
    assert proof_path.parent.resolve() == checkout / 'extensions/qa-lab/src'
    proof_path.write_bytes((assets / 'gateway-proof.mjs').read_bytes())
    proof_created = True
    env = runtime_env('gateway')
    env.update(OPENCLAW_BUILD_PRIVATE_QA='1', OPENCLAW_ENABLE_PRIVATE_QA_CLI='1', OPENCLAW_SKIP_CRON='1',
               OPENCLAW_TALK_PROOF_MODE='baseline', OPENCLAW_TALK_PROOF_DIR=str(phase_dir),
               OPENCLAW_TALK_PROOF_BINDING=str(phase_dir / 'execution-binding.json'))
    phase_binding = {**binding, 'sourceIdentity': before['sourceIdentity'], 'hostedProvenance': provenance,
                     'installedLockSHA256': installed_lock, 'nodeExecutable': node, 'envNames': sorted(env)}
    save(phase_dir / 'execution-binding.json', phase_binding)
    gateway_started = True
    try:
        run('baseline-gateway', [node, '--import', str(checkout / 'scripts/tsx.mjs'), str(proof_path)], checkout, env, phase_dir, 780)
    finally:
        source_guard('gateway', True)
        assert digest(proof_path) == binding['proofSHA256']
        assert inventory('runtime-after.json', before['sourceIdentity']) == built
    verdict = json.loads((phase_dir / 'gateway-verdict.json').read_text())
    assert verdict['schema'] == 'openclaw-134817-command-proof-v1' and verdict['mode'] == 'baseline'
    assert verdict['binding'] == phase_binding and verdict['completed'] is True
    assert not verdict['errors'] and not verdict['cleanupErrors']
    assert verdict['childCleanup']['confirmed'] is True
    assert verdict['childCleanup']['result'] == {'process': 'confirmed-stopped', 'errors': []}
    assert len(verdict['cases']) == 11 and all(row['passed'] is True for row in verdict['cases'])
    assert [row['id'] for row in verdict['cases']] == binding['expectedGatewayCaseIds']
    assert set(verdict['webhookReadiness']) == {'default', 'roomonly'}
    assert all(row['ready'] is True and row['status'] == 200 and row['body'] == 'ok'
               for row in verdict['webhookReadiness'].values())
    assert verdict['stagedBefore'] == verdict['stagedAfter']
    assert verdict['childStoppedBeforeFinalCounters'] is True
    assert verdict['providerInflightFinal'] == []
    assert verdict['providerFinal'] == [request for row in verdict['cases'] for request in row.get('modelRequests', [])]
    assert verdict['replies'] == [reply for row in verdict['cases'] for reply in row.get('replies', [])]
    assert verdict['childRuntime']['buildInventorySha256'] == digest(phase_dir / 'runtime-build.json')
    assert verdict['childRuntime']['requestedCommand']['argsPrefix'] == [str(checkout / 'dist/index.js')]
    child_runtime = verdict['childRuntime']
    port = child_runtime['gatewayPort']
    assert type(port) is int and 0 < port <= 65535
    assert type(child_runtime['pid']) is int and child_runtime['pid'] > 0
    assert child_runtime['gatewayBaseUrl'] == 'http://127.0.0.1:' + str(port)
    assert child_runtime['requestedCommand']['executablePath'] == node
    expected_launch_argv = [node, str(checkout / 'dist/index.js'), 'gateway', 'run',
                            '--port', str(port), '--bind', 'loopback', '--allow-unconfigured']
    assert child_runtime['canonicalLaunchArgv'] == expected_launch_argv
    assert child_runtime['observedCmdline'] == expected_launch_argv
    assert verdict['duplicateBefore'] == verdict['duplicateAfter']
    receipt.update(passed=True, phase='complete', gatewayBaselinePassed=True,
                   baselineIdentity=before['sourceIdentity'], gatewayVerdictSHA256=digest(phase_dir / 'gateway-verdict.json'))
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        if gateway_started:
            cleanup = json.loads((evidence / 'baseline/child-cleanup.json').read_text())
            assert cleanup['confirmed'] is True and not cleanup['errors'], 'Gateway closure unconfirmed; retain runtime'
        if proof_created:
            assert not proof_path.is_symlink() and digest(proof_path) == binding['proofSHA256']
            proof_path.unlink()
        if original_test is not None:
            assert digest(test_path) == binding['testSHA256']
            test_path.write_bytes(original_test)
            source_guard('restored', False)
        if scratch is not None:
            shutil.rmtree(scratch)
        receipt['ownedScratchRemoved'] = True
    except Exception as error:
        receipt['ownedScratchRemoved'] = False
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    # No runtime HOME/config/auth/state enters this artifact directory.
    try:
        files = [file for file in evidence.rglob('*') if file.is_file()]
        assert all(not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES for file in files)
        assert sum(file.stat().st_size for file in files) <= 64 * 1024 * 1024
        save(evidence / 'artifact-manifest.json', {str(file.relative_to(evidence)): digest(file) for file in files})
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'baselineRed', 'gatewayBaselinePassed', 'candidateStarted']}))
sys.exit(0 if receipt['passed'] else 1)
