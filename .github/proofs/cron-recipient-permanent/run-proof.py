"""Hosted-only, fixed-source permanent CronPage regression RED/GREEN proof. No credential hydration."""
from pathlib import Path
import hashlib
import json
import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import traceback

os.umask(0o077)
assets = Path(__file__).resolve().parent
source = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
receipt = {'passed': False, 'phase': 'preflight', 'commands': [], 'stages': {}, 'cleanupErrors': []}
scratch = None


def digest(file):
    result = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def save(file, value):
    Path(file).write_text(json.dumps(value, indent=2) + '\n')


def git(*args, root=source):
    return subprocess.check_output(
        ['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=root,
        env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'},
    )


def snapshot():
    files = {}
    for raw in git('ls-files', '-z').split(b'\0'):
        if not raw:
            continue
        name = raw.decode()
        file = source / name
        mode = file.lstat().st_mode
        if stat.S_ISLNK(mode):
            files[name] = {'link': os.readlink(file)}
        else:
            assert stat.S_ISREG(mode), name
            files[name] = {'sha256': digest(file), 'executable': bool(mode & 0o111)}
    index = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not index.is_absolute():
        index = source / index
    return {
        'head': git('rev-parse', 'HEAD').decode().strip(),
        'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
        'indexSHA256': digest(index),
        'tracked': files,
    }


def run(name, argv, cwd, env, timeout):
    receipt['phase'] = name
    result = {'name': name, 'argv': argv, 'exitCode': None}
    started = time.monotonic()
    child = None
    try:
        with (evidence / (name + '.stdout')).open('wb') as out, (evidence / (name + '.stderr')).open('wb') as err:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=err, start_new_session=True)
            try:
                result['exitCode'] = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                result['timedOut'] = True
                raise
        return result['exitCode']
    finally:
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(evidence / (name + '-result.json'), result)


def assert_tree(expected):
    actual = snapshot()
    assert actual == expected, 'Source/tree/index changed during execution'
    return actual


def assess(stage, exit_code, stage_dir):
    report = json.loads((stage_dir / 'vitest.json').read_text())
    suites = report['testResults']
    assert len(suites) == len(binding['testFiles']), 'Require every selected test file'
    actual_files = {str(Path(suite['name']).relative_to(source)) for suite in suites}
    assert actual_files == set(binding['testFiles'])
    rows = [(str(Path(suite['name']).relative_to(source)), row)
            for suite in suites for row in suite['assertionResults']]
    identities = [(file, row['fullName']) for file, row in rows]
    assert len(rows) == len(set(identities)) == report['numTotalTests']
    assert all(suite['assertionResults'] for suite in suites), 'No empty selected test file'
    assert report['numPendingTests'] == report.get('numTodoTests', 0) == 0
    assert report.get('numRuntimeErrorTestSuites', 0) == 0
    assert all(row['status'] in {'passed', 'failed'} for _, row in rows)
    expected_names = {binding['regressionAncestor'] + ' ' + title
                      for title in binding['regressionTitles']}
    regressions = {row['fullName']: row for file, row in rows
                   if file == binding['testPath'] and row['fullName'] in expected_names}
    assert set(regressions) == expected_names and len(regressions) == 3
    failures = [(file, row) for file, row in rows if row['status'] == 'failed']
    if stage == 'before':
        assert exit_code == 1 and report['success'] is False
        assert len(failures) == report['numFailedTests'] == 3
        assert {(file, row['fullName']) for file, row in failures} == {
            (binding['testPath'], name) for name in expected_names}
        for _, row in failures:
            messages = '\n'.join(row['failureMessages'])
            assert 'AssertionError: expected' in messages and 'to deeply equal' in messages
            location = '/' + binding['testPath'] + ':' + str(binding['regressionAssertionLine']) + ':'
            assert location in messages, 'Failure must be the recipient-list equality assertion'
    else:
        assert exit_code == 0 and report['success'] is True
        assert not failures and report['numFailedTests'] == 0
    assert report['numPassedTests'] == len(rows) - len(failures)
    assert report['numPassedTests'] > 0, 'Require existing sibling controls to execute'
    result = {'accepted': True, 'passedTests': report['numPassedTests'],
              'failedTests': report['numFailedTests'], 'totalTests': len(rows),
              'testFiles': sorted(actual_files),
              'tests': sorted([{'file': file, 'name': row['fullName'], 'status': row['status']}
                               for file, row in rows], key=lambda row: (row['file'], row['name']))}
    save(stage_dir / 'assessment.json', result)
    return result


try:
    assert platform.system() == 'Linux'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/cron-recipient-permanent-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert source.name == 'source' and source.is_dir()
    proof_checkout = assets.parents[2]
    assert git('rev-parse', 'HEAD', root=proof_checkout).decode().strip() == os.environ['GITHUB_SHA']
    manifest = json.loads((assets / 'manifest.json').read_text())
    for name, expected in manifest['sha256'].items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(proof_checkout / name) == expected, name
    binding = json.loads((assets / 'binding.json').read_text())
    assert git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/openclaw/openclaw'
    assert not git('status', '--porcelain=v1', '--untracked-files=all').strip()
    credential_keys = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp', '(extraheader|credential)'], cwd=source, capture_output=True)
    assert credential_keys.returncode == 1 and not credential_keys.stdout
    pristine = snapshot()
    assert pristine['head'] == binding['baselineHead'] and pristine['tree'] == binding['baselineTree']
    for name, expected in binding['baselineSourceSHA256'].items():
        assert digest(source / name) == expected, name
    assert json.loads((source / 'package.json').read_text())['packageManager'] == binding['packageManager']
    assert not (source / 'node_modules').exists(), 'Require fresh frozen installation'
    save(evidence / 'source-pristine.json', pristine)
    save(evidence / 'binding.json', binding)
    node = str(Path(shutil.which('node')).resolve())
    assert subprocess.check_output([node, '--version'], text=True).strip() == 'v' + binding['nodeVersion']
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file()
    scratch = Path(tempfile.mkdtemp(prefix='oc-cron-', dir='/tmp'))
    for name in ['home', 'corepack', 'bin', 'tmp', 'config', 'cache', 'data']:
        (scratch / name).mkdir(mode=0o700)
    child_env = {
        'PATH': str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin',
        'HOME': str(scratch / 'home'), 'CI': '1', 'COREPACK_HOME': str(scratch / 'corepack'),
        'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'TMPDIR': str(scratch / 'tmp'),
        'XDG_CONFIG_HOME': str(scratch / 'config'), 'XDG_CACHE_HOME': str(scratch / 'cache'),
        'XDG_DATA_HOME': str(scratch / 'data'),
    }
    save(evidence / 'environment.json', {
        'childEnvironment': child_env, 'proofAssetsCommit': os.environ['GITHUB_SHA'],
        'provenance': {key: os.environ[key] for key in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']},
    })
    assert run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], scratch, child_env, 300) == 0
    assert run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], scratch, child_env, 300) == 0
    pnpm = str(scratch / 'bin/pnpm')
    assert run('pnpm-version', [pnpm, '--version'], scratch, child_env, 300) == 0
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == binding['pnpmVersion']
    assert run('install', [pnpm, 'install', '--frozen-lockfile'], source, child_env, 1200) == 0
    assert_tree(pristine)
    installed_lock = source / 'node_modules/.pnpm/lock.yaml'
    dependency_lock_sha = digest(installed_lock)
    proof = source / binding['testPath']
    assert digest(proof) == binding['testBeforeSHA256']
    proof.write_bytes((assets / 'cron-page.test.ts').read_bytes())
    assert digest(proof) == binding['testAfterSHA256']
    expected = snapshot()
    assert all(expected[key] == pristine[key] for key in ['head', 'tree', 'indexSHA256'])
    assert {p for p in pristine['tracked'] if pristine['tracked'][p] != expected['tracked'][p]} == {binding['testPath']}
    save(evidence / 'dependency-lock.json', {'repositoryLockSHA256': digest(source / 'pnpm-lock.yaml'),
                                          'installedLockSHA256': dependency_lock_sha,
                                          'packageManager': binding['packageManager']})
    for stage in ['before', 'after']:
        if stage == 'after':
            owner = source / binding['ownerPath']
            assert digest(owner) == binding['ownerBeforeSHA256']
            owner.write_bytes((assets / 'form-suggestions.ts').read_bytes())
            assert digest(owner) == binding['ownerAfterSHA256']
            next_snapshot = snapshot()
            assert {p for p in expected['tracked'] if expected['tracked'][p] != next_snapshot['tracked'][p]} == {binding['ownerPath']}
            assert next_snapshot['head'] == expected['head'] and next_snapshot['tree'] == expected['tree'] and next_snapshot['indexSHA256'] == expected['indexSHA256']
            expected = next_snapshot
        stage_dir = evidence / stage
        stage_dir.mkdir(mode=0o700)
        stage_env = dict(child_env)
        for key, name in [('HOME', 'home'), ('TMPDIR', 'tmp'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data')]:
            location = scratch / (stage + '-' + name)
            location.mkdir(mode=0o700)
            stage_env[key] = str(location)
        save(stage_dir / 'source-before.json', assert_tree(expected))
        assert digest(proof) == binding['testAfterSHA256']
        assert digest(installed_lock) == dependency_lock_sha
        argv = [node, 'scripts/run-vitest.mjs', 'run', '--config', binding['vitestConfig'], '--configLoader', 'runner', *binding['testFiles'], '--reporter=default', '--reporter=json', '--outputFile.json=' + str(stage_dir / 'vitest.json')]
        try:
            code = run(stage + '-unit', argv, source, stage_env, 1200)
        finally:
            observed_after = snapshot()
            save(stage_dir / 'source-after.json', observed_after)
            lock_after = digest(installed_lock)
            save(stage_dir / 'dependency-lock.json', {'beforeSHA256': dependency_lock_sha,
                                                     'afterSHA256': lock_after,
                                                     'unchanged': lock_after == dependency_lock_sha})
            assert observed_after == expected, 'Source/tree/index changed during unit execution'
            assert lock_after == dependency_lock_sha
        assert digest(proof) == binding['testAfterSHA256']
        assert digest(installed_lock) == dependency_lock_sha
        receipt['stages'][stage] = assess(stage, code, stage_dir)
        save(evidence / 'hosted-proof-result.json', receipt)
    before_tests = {(row['file'], row['name']) for row in receipt['stages']['before']['tests']}
    after_tests = {(row['file'], row['name']) for row in receipt['stages']['after']['tests']}
    assert before_tests == after_tests, 'Before and after must execute the identical test inventory'
    receipt.update(passed=True, phase='complete', baselineHead=binding['baselineHead'],
                   ownerAfterSHA256=binding['ownerAfterSHA256'], installedLockSHA256=dependency_lock_sha)
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if scratch is not None:
            shutil.rmtree(scratch)
            assert not scratch.exists()
            receipt['privateScratchRemoved'] = True
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    try:
        artifact_hashes = {}
        for file in evidence.rglob('*'):
            assert not file.is_symlink(), 'Evidence must not contain symlinks'
            if file.is_file():
                assert file.suffix in {'.json', '.stdout', '.stderr', '.txt'}
                artifact_hashes[str(file.relative_to(evidence))] = digest(file)
        save(evidence / 'artifact-sha256.json', artifact_hashes)
    except Exception as error:
        receipt.update(passed=False, artifactError=str(error))
        save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({'pr': 134368, 'passed': receipt['passed'], 'phase': receipt['phase']}))
sys.exit(0 if receipt['passed'] else 1)
