"""Hosted-only, published-head CronPage owner-reversal RED/GREEN proof. No credential hydration."""
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


def observations(stage_dir):
    rows = [json.loads(p.read_text()) for p in (stage_dir / 'ui').rglob('observations.json')]
    result = {row['caseId']: row for row in rows}
    assert len(rows) == len(result) == 4, 'Require exactly four executed cases'
    assert set(result) == {'telegram', 'last', 'webhook', 'same-channel-collision-manual-entry'}
    for row in rows:
        assert row['schema'] == 'openclaw-cron-recipient-ui-proof-v1'
        assert row['servedOwner']['path'] == '/src/pages/cron/form-suggestions.ts'
        assert len(row['servedOwner']['sha256']) == 64
        assert row['recipientInputList'] == 'cron-delivery-to-suggestions'
        assert row['accountInputList'] == 'cron-delivery-account-suggestions'
        methods = {request['method'] for request in row['requests']}
        assert {'channels.status', 'cron.list'} <= methods
        assert 'cron.run' not in methods
        assert row['screenshot'].endswith('.png')
    assert result['same-channel-collision-manual-entry']['inputMethod'] == 'manual-keyboard-text'
    assert result['same-channel-collision-manual-entry']['enteredRecipient'] == '-1001234567890'
    assert result['same-channel-collision-manual-entry']['status'] == 'pass'
    return result


def assess(stage, exit_code, stage_dir):
    report = json.loads((stage_dir / 'vitest.json').read_text())
    rows = observations(stage_dir)
    assert report['numTotalTests'] == 4
    assert report['numPendingTests'] == report.get('numTodoTests', 0) == 0
    assert report.get('numRuntimeErrorTestSuites', 0) == 0
    accounts = ['default', 'Account only', 'work', '-1001234567890', 'webhook-name',
                'https://example.test/account-name']
    recipients = ['-1001234567890', 'channel:123456789012345678', 'https://example.test/hooks/saved']
    for case in ['telegram', 'last', 'webhook']:
        expected_accounts = accounts + (['discord-only', 'Discord account only'] if case == 'last' else [])
        assert rows[case]['accountOptions'] == expected_accounts
        if stage == 'before':
            old_targets = sorted(set(recipients + expected_accounts))
            expected = [v for v in old_targets if v.startswith(('http://', 'https://'))] if case == 'webhook' else old_targets
            assert rows[case]['recipientOptions'] == expected
            assert rows[case]['status'] == 'fail'
        else:
            assert rows[case]['recipientOptions'] == (['https://example.test/hooks/saved'] if case == 'webhook' else recipients)
            assert rows[case]['status'] == 'pass'
    expected_passed = 1 if stage == 'before' else 4
    assert report['numPassedTests'] == expected_passed
    assert report['numFailedTests'] == 4 - expected_passed
    assert report['success'] is (stage == 'after')
    assert (exit_code != 0) if stage == 'before' else (exit_code == 0)
    pngs = list((stage_dir / 'ui').rglob('*.png'))
    videos = list((stage_dir / 'ui').rglob('*.webm'))
    assert len(pngs) >= 5 and len(videos) == 4, 'Require completed screenshots and one video per case'
    return {'accepted': True, 'passedTests': expected_passed, 'failedTests': 4 - expected_passed,
            'cases': {key: row['status'] for key, row in rows.items()},
            'screenshots': len(pngs), 'videos': len(videos)}


try:
    assert platform.system() == 'Linux'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/cron-recipient-ui-proof'
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
    assert pristine['head'] == binding['checkoutHead'] and pristine['tree'] == binding['checkoutTree']
    for name, expected in binding['checkoutSourceSHA256'].items():
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
    for name in ['home', 'corepack', 'bin', 'tmp', 'config', 'cache', 'data', 'browsers']:
        (scratch / name).mkdir(mode=0o700)
    child_env = {
        'PATH': str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin',
        'HOME': str(scratch / 'home'), 'CI': '1', 'COREPACK_HOME': str(scratch / 'corepack'),
        'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'TMPDIR': str(scratch / 'tmp'),
        'XDG_CONFIG_HOME': str(scratch / 'config'), 'XDG_CACHE_HOME': str(scratch / 'cache'),
        'XDG_DATA_HOME': str(scratch / 'data'), 'PLAYWRIGHT_BROWSERS_PATH': str(scratch / 'browsers'),
    }
    save(evidence / 'environment.json', {
        'childEnvironment': child_env, 'proofAssetsCommit': os.environ['GITHUB_SHA'],
        'provenance': {key: os.environ[key] for key in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']},
    })
    assert run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], scratch, child_env, 300) == 0
    assert run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], scratch, child_env, 300) == 0
    pnpm = str(scratch / 'bin/pnpm')
    assert run('pnpm-version', [pnpm, '--version'], scratch, child_env, 300) == 0
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    assert run('install', [pnpm, 'install', '--frozen-lockfile'], source, child_env, 1200) == 0
    assert_tree(pristine)
    installed_lock = source / 'node_modules/.pnpm/lock.yaml'
    dependency_lock_sha = digest(installed_lock)
    assert run('chromium', [node, '--import', 'tsx', 'scripts/ensure-playwright-chromium.mts'], source, child_env, 600) == 0
    assert_tree(pristine)
    proof = source / binding['proofPath']
    assert not proof.exists()
    proof.write_bytes((assets / 'proof.e2e.test.ts').read_bytes())
    assert digest(proof) == binding['proofSHA256']
    classification = source / binding['classificationPath']
    assert digest(classification) == binding['classificationBeforeSHA256']
    classification.write_bytes((assets / 'vitest.ui-e2e.config.ts').read_bytes())
    assert digest(classification) == binding['classificationAfterSHA256']
    expected = snapshot()
    assert all(expected[key] == pristine[key] for key in ['head', 'tree', 'indexSHA256'])
    assert {p for p in pristine['tracked'] if pristine['tracked'][p] != expected['tracked'][p]} == {binding['classificationPath']}
    for stage in ['before', 'after']:
        if stage == 'before':
            owner = source / binding['ownerPath']
            assert digest(owner) == binding['ownerAfterSHA256']
            assert pristine['tracked'][binding['ownerPath']]['sha256'] == binding['ownerAfterSHA256']
            owner.write_bytes((assets / 'before-form-suggestions.ts').read_bytes())
            assert digest(owner) == binding['ownerBeforeSHA256']
            next_snapshot = snapshot()
            assert {p for p in expected['tracked'] if expected['tracked'][p] != next_snapshot['tracked'][p]} == {binding['ownerPath']}
            assert all(next_snapshot[key] == expected[key] for key in ['head', 'tree', 'indexSHA256'])
            expected = next_snapshot
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
        stage_env['OPENCLAW_UI_E2E_ARTIFACT_DIR'] = str(stage_dir / 'ui')
        stage_env['OPENCLAW_UI_E2E_DIAGNOSTIC_DIR'] = str(stage_dir / 'diagnostics')
        save(stage_dir / 'source-before.json', assert_tree(expected))
        assert digest(proof) == binding['proofSHA256']
        assert digest(installed_lock) == dependency_lock_sha
        argv = [node, 'scripts/run-vitest.mjs', 'run', '--config', binding['classificationPath'], '--configLoader', 'runner', binding['proofPath'], '--reporter=default', '--reporter=json', '--outputFile.json=' + str(stage_dir / 'vitest.json')]
        try:
            code = run(stage + '-ui', argv, source, stage_env, 1200)
        finally:
            observed_after = snapshot()
            save(stage_dir / 'source-after.json', observed_after)
            assert observed_after == expected, 'Source/tree/index changed during UI execution'
        assert digest(proof) == binding['proofSHA256']
        assert digest(installed_lock) == dependency_lock_sha
        receipt['stages'][stage] = assess(stage, code, stage_dir)
        save(evidence / 'hosted-proof-result.json', receipt)
    assert {p for p in pristine['tracked'] if pristine['tracked'][p] != expected['tracked'][p]} == {binding['classificationPath']}
    assert expected['tracked'][binding['ownerPath']] == pristine['tracked'][binding['ownerPath']]
    receipt.update(passed=True, phase='complete', checkoutHead=binding['checkoutHead'],
                   beforeOwnerSource=binding['beforeOwnerSource'],
                   ownerRestoredToPublishedHead=True,
                   ownerAfterSHA256=binding['ownerAfterSHA256'], installedLockSHA256=dependency_lock_sha)
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if scratch is not None:
            shutil.rmtree(scratch)
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    try:
        artifact_hashes = {}
        for file in evidence.rglob('*'):
            assert not file.is_symlink(), 'Evidence must not contain symlinks'
            if file.is_file():
                assert file.suffix in {'.json', '.png', '.webm', '.stdout', '.stderr', '.txt'}
                if file.suffix in {'.png', '.webm'}:
                    with file.open('rb') as media:
                        prefix = media.read(8)
                    assert prefix == b'\x89PNG\r\n\x1a\n' if file.suffix == '.png' else prefix[:4] == b'\x1a\x45\xdf\xa3'
                artifact_hashes[str(file.relative_to(evidence))] = digest(file)
        save(evidence / 'artifact-sha256.json', artifact_hashes)
    except Exception as error:
        receipt.update(passed=False, artifactError=str(error))
        save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({'pr': 134368, 'passed': receipt['passed'], 'phase': receipt['phase']}))
sys.exit(0 if receipt['passed'] else 1)
