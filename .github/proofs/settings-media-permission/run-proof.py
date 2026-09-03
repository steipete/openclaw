"""Hosted-only, fixed-source Settings media permission baseline-only RED proof. No credential hydration."""
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
receipt = {'passed': False, 'mode': 'baseline-only', 'candidateExecuted': False, 'phase': 'preflight', 'commands': [], 'stages': {}, 'cleanupErrors': [], 'closureUncertain': False}
scratch = None
proof = None
proof_created = False
restores = {}
pristine = None
expected = None


def interrupted(signum, _frame):
    receipt['closureUncertain'] = True
    raise InterruptedError('Controller interrupted by ' + signal.Signals(signum).name)


for signum in [signal.SIGTERM, signal.SIGINT]:
    signal.signal(signum, interrupted)


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


def retained_resources():
    namespaces = sorted(str(file.relative_to(scratch)) for file in scratch.rglob('.vitest-resource-owner')) if scratch else []
    workers = source / '.artifacts/vitest-workers'
    generations = sorted(file.name for file in workers.iterdir() if file.is_dir()) if workers.exists() else []
    return {'namespaces': namespaces, 'workerGenerations': generations}


def run(name, argv, cwd, env, timeout):
    receipt['phase'] = name
    result = {'name': name, 'argv': argv, 'exitCode': None, 'leaderReaped': False}
    started = time.monotonic()
    child = None
    resources_before = retained_resources()
    try:
        with (evidence / (name + '.stdout')).open('wb') as out, (evidence / (name + '.stderr')).open('wb') as err:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=err, start_new_session=True)
            result['pid'] = child.pid
            result['exitCode'] = child.wait(timeout=timeout)
            result['leaderReaped'] = True
        assert result['exitCode'] >= 0, 'Command terminated by signal'
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            result['outerGroupGone'] = True
        else:
            raise RuntimeError('Outer process group remains; descendant closure unverified')
        result['resourcesAfter'] = retained_resources()
        assert not result['resourcesAfter']['namespaces'], 'Canonical Vitest namespace retained'
        assert result['resourcesAfter']['workerGenerations'] == resources_before['workerGenerations'], 'Canonical worker generation retained'
        if name in {'before-regressions', 'before-ui'}:
            logs = ''.join((evidence / (name + suffix)).read_text(errors='replace') for suffix in ['.stdout', '.stderr'])
            # Pinned Vitest close() logs rejected teardown promises after reporters ran.
            assert 'error during close' not in logs and 'close timed out after' not in logs, 'Vitest close failed'
        return result['exitCode']
    except BaseException as error:
        result['timedOut'] = isinstance(error, subprocess.TimeoutExpired)
        if child is not None:
            receipt['closureUncertain'] = True
            # Let the canonical launcher forward termination to its detached owners.
            # Any timeout remains uncertain even if this outer leader later exits.
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    result['terminationSignal'] = 'SIGTERM'
                    result['exitCode'] = child.wait(timeout=10)
                    result['leaderReaped'] = True
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                        result['terminationSignal'] = 'SIGKILL'
                        result['exitCode'] = child.wait(timeout=5)
                        result['leaderReaped'] = True
                    except (ProcessLookupError, subprocess.TimeoutExpired) as stop_error:
                        result['terminationError'] = str(stop_error)
                except ProcessLookupError as stop_error:
                    result['terminationError'] = str(stop_error)
        raise
    finally:
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(evidence / (name + '-result.json'), result)


def assess_lifecycle(report_path, expected_paths, ui=False):
    lifecycle = json.loads(Path(str(report_path) + '.lifecycle.json').read_text())
    assert lifecycle['schema'] == 'settings-media-lifecycle-v1'
    assert lifecycle['vitestVersion'] == '4.1.11'
    assert lifecycle['runEnded'] is True and lifecycle['reason'] == 'failed'
    assert lifecycle['processTimeout'] is False and lifecycle['unhandledErrors'] == []
    assert len(lifecycle['modules']) == len(expected_paths)
    assert {str(Path(module['path']).relative_to(source)) for module in lifecycle['modules']} == set(expected_paths)
    for module in lifecycle['modules']:
        assert module['errors'] == [], module['path']
        assert all(suite['errors'] == [] for suite in module['suites']), module['path']
    if ui:
        assert lifecycle['afterAllOwners'] == ['Settings media permission lifetime'], 'Canonical browser/server cleanup hook must complete'
    return lifecycle


def assert_cleanup_allowed():
    assert not receipt['closureUncertain'], 'Subprocess closure uncertain; retain task state'
    assert not any(retained_resources().values()), 'Canonical resource owner retained; preserve its evidence'
    if 'before' in receipt['stages']:
        stage = receipt['stages']['before']
        assert set(stage) == {'regressions', 'ui'} and all(result.get('accepted') is True for result in stage.values()), 'Expected suite/lifecycle proof incomplete; retain task state'


def assert_tree(expected):
    actual = snapshot()
    assert actual == expected, 'Source/tree/index changed during execution'
    return actual


def assess_units(exit_code, report_path):
    report = json.loads(report_path.read_text())
    assess_lifecycle(report_path, binding['regressionPaths'])
    suites = report['testResults']
    assert len(suites) == len(binding['regressionPaths'])
    assert {str(Path(row['name']).relative_to(source)) for row in suites} == set(binding['regressionPaths'])
    rows = [test for suite in suites for test in suite['assertionResults']]
    active = [row for row in rows if row['status'] in {'passed', 'failed'}]
    names = {row['fullName']: row for row in active}
    assert len(names) == len(active), 'Duplicate executed test names'
    assert not any(row['status'] in {'todo', 'disabled'} for row in rows)
    expected_cases = binding['beforeUnitCases']
    assert set(names) == set(expected_cases), 'Exact 22-case lifetime inventory required'
    for name, row in names.items():
        assert row['status'] == expected_cases[name], name
        if row['status'] == 'failed':
            assert row['failureMessages'] and all('AssertionError' in message for message in row['failureMessages'])
            location = binding['unitFailureLocations']['Settings' if ': Settings ' in name else 'composer']
            assert all(f"{location['path']}:{location['line']}:" in message for message in row['failureMessages']), name
    assert all(row['fullName'] not in expected_cases for row in rows if row not in active)
    assert report['success'] is False and exit_code == 1
    return {'accepted': True, 'executed': len(active),
            'passed': sum(row['status'] == 'passed' for row in active),
            'failed': sum(row['status'] == 'failed' for row in active),
            'intentionallyFiltered': len(rows) - len(active),
            'names': {name: row['status'] for name, row in names.items()}}


def assess_ui(exit_code, stage_dir):
    report = json.loads((stage_dir / 'vitest.json').read_text())
    assess_lifecycle(stage_dir / 'vitest.json', [binding['proofPath']], ui=True)
    files = list((stage_dir / 'ui').rglob('observations.json'))
    rows = [json.loads(file.read_text()) for file in files]
    observed = {row['caseId']: row for row in rows}
    assert len(rows) == len(observed) == 8
    assert set(observed) == set(binding['uiCases'])
    suites = report['testResults']
    assert len(suites) == 1 and str(Path(suites[0]['name']).relative_to(source)) == binding['proofPath']
    tests = suites[0]['assertionResults']
    expected_names = {f"Settings media permission lifetime {row['kind']}: {row['transition']}": row for row in rows}
    assert len(tests) == len(expected_names) == 8
    assert {test['fullName'] for test in tests} == set(expected_names)
    for test in tests:
        stays = expected_names[test['fullName']]['transition'] == 'stay'
        assert test['status'] == ('passed' if stays else 'failed')
        if not stays:
            location = binding['uiFailureLocation']
            assert test['failureMessages'] and all('AssertionError' in message and f"{location['path']}:{location['line']}:" in message for message in test['failureMessages'])
    assert report['numTotalTests'] == 8
    assert report['numPendingTests'] == report.get('numTodoTests', 0) == 0
    for row, file in zip(rows, files):
        assert row['schema'] == 'openclaw-settings-media-permission-proof-v1'
        assert row['contextClosed'] is True
        assert row['ownerConnectedAtGesture'] is True
        if row['transition'] == 'disconnect':
            assert row['ownerConnectedAfterExit'] is False
        surface = row['settlementSurface']
        if row['transition'] in {'route leave', 'second await'}:
            assert row['ownerConnectedAfterExit'] is True
            assert surface['route'] == '/settings/advanced'
            assert surface['ownerConnected'] is True and surface['ownerPageId'] == 'advanced'
            assert surface['appearancePickerCount'] == 0 and 'Advanced' in surface['headings']
        stays = row['transition'] == 'stay'
        assert row['status'] == ('pass' if stays else 'fail')
        assert row['probesAfterSettlement'] == 1
        if not stays:
            assert row['probesBeforeFreshGesture'] == 1
        assert row['finalRoute'] == '/settings/appearance'
        expected_exit = '/settings/appearance' if stays else '/new' if row['transition'] == 'disconnect' else '/settings/advanced'
        assert row['exitRoute'] == expected_exit
        events = row['finalEvents']
        probes = [event for event in events if event['type'] == 'probe']
        pointer_indexes = [index for index, event in enumerate(events) if event['type'] == 'pointer']
        pointers = [events[index] for index in pointer_indexes]
        assert len(probes) == len([event for event in events if event['type'] == 'stop']) == 1
        assert probes[0]['route'] == ('/settings/appearance' if stays else expected_exit)
        released_id = 3 if row['transition'] == 'second await' else 1 if row['kind'] == 'microphone' else 2
        released = [event for event in events if event['type'] == 'resolve' and event['id'] == released_id]
        assert len(released) == 1 and released[0]['route'] == expected_exit
        assert pointer_indexes[0] < events.index(released[0]) < events.index(probes[0])
        assert probes[0]['constraints'] == ({'audio': True} if row['kind'] == 'microphone' else {'video': True})
        assert len(pointers) == (1 if stays else 2) and all(event['trusted'] for event in pointers)
        assert events[0]['type'] == events[1]['type'] == 'enumerate'
        assert {events[0]['id'], events[1]['id']} == {1, 2}
        if row['transition'] == 'second await':
            assert len([event for event in events if event['type'] == 'reject']) == 1
            assert any(event['type'] == 'resolve' and event['id'] == 3 for event in events)
        assert set(row['servedOwners']) == {'/src/pages/config/config-page.ts', '/src/pages/chat/realtime-talk-input.ts'}
        assert all(len(value) == 64 for value in row['servedOwners'].values())
        assert all((file.parent / name).is_file() for name in [
            'appearance-sidebar.png', 'appearance-pending.png', 'settled-surface.png', 'fresh-gesture-result.png'])
        assert len(list(file.parent.glob('*.webm'))) == 1
    expected_passed = 2
    assert report['numPassedTests'] == expected_passed and report['numFailedTests'] == 8 - expected_passed
    assert report['success'] is False and exit_code == 1
    hashes = {key: {row['servedOwners'][key] for row in rows} for key in rows[0]['servedOwners']}
    assert all(len(values) == 1 for values in hashes.values()), 'One served owner version per stage'
    return {'accepted': True, 'passedTests': expected_passed, 'failedTests': 8 - expected_passed,
            'cases': {key: row['status'] for key, row in observed.items()},
            'servedOwnerSHA256': {key: next(iter(values)) for key, values in hashes.items()},
            'retirementSurfaceVerified': True, 'screenshots': 32, 'videos': 8}


try:
    assert platform.system() == 'Linux'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/settings-media-permission-baseline-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert source.name == 'source' and source.is_dir()
    proof_checkout = assets.parents[2]
    assert git('rev-parse', 'HEAD', root=proof_checkout).decode().strip() == os.environ['GITHUB_SHA']
    manifest = json.loads((assets / 'manifest.json').read_text())
    for name, expected_hash in manifest['sha256'].items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(proof_checkout / name) == expected_hash, name
    binding = json.loads((assets / 'binding.json').read_text())
    assert binding['executionAllowed'] is True
    assert binding['mode'] == 'baseline-only' and binding['candidateExecutionAllowed'] is False
    assert not (assets / 'candidate').exists()
    assert set(binding['unitPaths']) == set(binding['regressionPaths'])
    assert all(name.endswith('.test.ts') for name in binding['unitPaths'])
    assert os.environ['GITHUB_REF'] == binding['proofRef']
    assert git('remote', 'get-url', 'origin').decode().strip() == 'https://github.com/openclaw/openclaw'
    assert not git('status', '--porcelain=v1', '--untracked-files=all').strip()
    credential_keys = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp', '(extraheader|credential)'], cwd=source, capture_output=True)
    assert credential_keys.returncode == 1 and not credential_keys.stdout
    pristine = snapshot()
    assert pristine['head'] == binding['baselineHead'] and pristine['tree'] == binding['baselineTree']
    for name, expected_hash in binding['baselineSourceSHA256'].items():
        assert digest(source / name) == expected_hash, name
    assert json.loads((source / 'package.json').read_text())['packageManager'] == binding['packageManager']
    assert not (source / 'node_modules').exists(), 'Require fresh frozen installation'
    save(evidence / 'source-pristine.json', pristine)
    save(evidence / 'binding.json', binding)
    node = str(Path(shutil.which('node')).resolve())
    assert subprocess.check_output([node, '--version'], text=True).strip() == 'v' + binding['nodeVersion']
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file()
    scratch = Path(tempfile.mkdtemp(prefix='oc-media-', dir='/tmp'))
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
    receipt['installedLockSHA256'] = dependency_lock_sha
    runtime_packages = {}
    for name, expected_version in binding['runtimePackages'].items():
        package = source / name
        data = json.loads(package.read_text())
        assert data['version'] == expected_version, name
        runtime_packages[name] = {'name': data['name'], 'version': data['version'], 'sha256': digest(package)}
    save(evidence / 'runtime-packages.json', runtime_packages)
    browser_manifest = source / 'node_modules/playwright-core/browsers.json'
    save(evidence / 'playwright-browser-manifest.json', json.loads(browser_manifest.read_text()))
    receipt['playwrightBrowserManifestSHA256'] = digest(browser_manifest)
    assert run('chromium', [node, '--import', 'tsx', 'scripts/ensure-playwright-chromium.mts'], source, child_env, 600) == 0
    assert_tree(pristine)
    proof = source / binding['proofPath']
    assert not proof.exists()
    with proof.open('xb') as handle:
        handle.write((assets / 'proof.e2e.test.ts').read_bytes())
    proof_created = True
    assert digest(proof) == binding['proofSHA256']
    classification = source / binding['classificationPath']
    assert digest(classification) == binding['classificationBeforeSHA256']
    restores[binding['classificationPath']] = (classification.read_bytes(), binding['classificationAfterSHA256'])
    classification.write_bytes((assets / 'vitest.ui-e2e.config.ts').read_bytes())
    assert digest(classification) == binding['classificationAfterSHA256']
    for name in binding['unitPaths']:
        assert digest(source / name) == binding['baselineSourceSHA256'][name]
        restores[name] = ((source / name).read_bytes(), binding['testOverlaySHA256'][name])
        (source / name).write_bytes((assets / 'tests' / name).read_bytes())
        assert digest(source / name) == binding['testOverlaySHA256'][name]
    expected = snapshot()
    assert all(expected[key] == pristine[key] for key in ['head', 'tree', 'indexSHA256'])
    assert {name for name in pristine['tracked'] if pristine['tracked'][name] != expected['tracked'][name]} == set(binding['unitPaths']) | {binding['classificationPath']}
    for stage in ['before']:
        stage_dir = evidence / stage
        stage_dir.mkdir(mode=0o700)
        stage_env = dict(child_env)
        for key, name in [('HOME', 'home'), ('TMPDIR', 'tmp'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data')]:
            location = scratch / (stage + '-' + name)
            location.mkdir(mode=0o700)
            stage_env[key] = str(location)
        stage_env['OPENCLAW_CAPTURE_UI_PROOF'] = '1'
        stage_env['OPENCLAW_UI_E2E_ARTIFACT_DIR'] = str(stage_dir / 'ui')
        stage_env['OPENCLAW_UI_E2E_DIAGNOSTIC_DIR'] = str(stage_dir / 'diagnostics')
        save(stage_dir / 'source-before.json', assert_tree(expected))
        assert digest(proof) == binding['proofSHA256']
        assert digest(installed_lock) == dependency_lock_sha
        stage_result = {}
        receipt['stages'][stage] = stage_result
        try:
            unit_report = stage_dir / 'regressions.json'
            argv = [node, 'scripts/run-vitest.mjs', 'run', '--config', 'test/vitest/vitest.ui.config.ts', '--configLoader', 'runner', *binding['regressionPaths'], '--testNamePattern=media permission lifetime:', '--reporter=default', '--reporter=json', '--reporter=' + str(assets / 'lifecycle-reporter.mjs'), '--outputFile.json=' + str(unit_report)]
            code = run(stage + '-regressions', argv, source, stage_env, 1200)
            try:
                stage_result['regressions'] = assess_units(code, unit_report)
            except Exception as error:
                stage_result['regressions'] = {'accepted': False, 'error': str(error)}
                (stage_dir / 'regression-assessment-failure.txt').write_text(traceback.format_exc())
            # Independent browser evidence still runs after an inventory/assertion mismatch,
            # but never after a source or dependency-integrity failure.
            assert_tree(expected)
            assert digest(proof) == binding['proofSHA256']
            assert digest(installed_lock) == dependency_lock_sha
            argv = [node, 'scripts/run-vitest.mjs', 'run', '--config', binding['classificationPath'], '--configLoader', 'runner', binding['proofPath'], '--reporter=default', '--reporter=json', '--reporter=' + str(assets / 'lifecycle-reporter.mjs'), '--outputFile.json=' + str(stage_dir / 'vitest.json')]
            code = run(stage + '-ui', argv, source, stage_env, 1200)
            try:
                stage_result['ui'] = assess_ui(code, stage_dir)
            except Exception as error:
                stage_result['ui'] = {'accepted': False, 'error': str(error)}
                (stage_dir / 'ui-assessment-failure.txt').write_text(traceback.format_exc())
        finally:
            observed_after = snapshot()
            save(stage_dir / 'source-after.json', observed_after)
            assert observed_after == expected, 'Source/tree/index changed during execution'
            assert digest(proof) == binding['proofSHA256']
            assert digest(installed_lock) == dependency_lock_sha
        receipt['stages'][stage] = stage_result
        save(evidence / 'hosted-proof-result.json', receipt)
    assert all(result.get('accepted') is True for result in receipt['stages']['before'].values()), 'Baseline assessment failed; retain raw evidence'
    receipt.update(passed=True, phase='complete', baselineHead=binding['baselineHead'],
                   candidateExecuted=False,
                   executedProductionSHA256={name: binding['baselineSourceSHA256'][name] for name in binding['productionPaths']},
                   executedUnitSHA256=binding['testOverlaySHA256'],
                   hostedProofSHA256=binding['proofSHA256'],
                   permanentBrowserTestSHA256Unexecuted=binding['permanentBrowserTestSHA256Unexecuted'],
                   installedLockSHA256=dependency_lock_sha)

except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        assert_cleanup_allowed()
        if expected is not None:
            save(evidence / 'source-before-cleanup.json', assert_tree(expected))
        if proof_created:
            assert proof is not None and proof.is_file() and not proof.is_symlink()
            assert digest(proof) == binding['proofSHA256'], 'Do not delete altered proof'
            proof.unlink()
            receipt['proofOverlayRemoved'] = True
        for name, (original_bytes, overlay_sha) in restores.items():
            target = source / name
            assert target.is_file() and not target.is_symlink()
            assert digest(target) == overlay_sha, 'Do not overwrite altered overlay: ' + name
            target.write_bytes(original_bytes)
        if pristine is not None:
            save(evidence / 'source-restored.json', assert_tree(pristine))
            receipt['trackedOverlaysRestored'] = True
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    try:
        if scratch is not None:
            assert_cleanup_allowed()
            shutil.rmtree(scratch)
            receipt['privateScratchRemoved'] = not scratch.exists()
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
    print(json.dumps({'pr': 128482, 'passed': receipt['passed'], 'phase': receipt['phase']}))
sys.exit(0 if receipt['passed'] else 1)
