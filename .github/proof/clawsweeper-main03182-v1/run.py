"""Held hosted reassessment: exact unmodified public main, its candidate24 recipe, and four original observations."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time

P = Path(__file__).resolve().parent
R = Path(sys.argv[2]).resolve()
O = Path(sys.argv[3]).resolve()
S = json.loads((P / 'source.json').read_text())

def digest(data):
    return hashlib.sha256(data).hexdigest()

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def git(*args):
    return subprocess.check_output(['git', '--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', *args], cwd=R)

def bind_inputs():
    expected = json.loads((P / 'inputs.json').read_text())
    assert {x.name for x in P.iterdir()} == set(expected) | {'inputs.json'}
    for name, row in expected.items():
        path = P / name
        assert stat.S_ISREG(path.lstat().st_mode), name
        data = path.read_bytes()
        assert len(data) == row['bytes'] and digest(data) == row['sha256'], name
    return digest((P / 'inputs.json').read_bytes())

def bind_source():
    rows = S['source']
    raw = git('ls-files', '--stage', '-z')
    assert len(raw) == S['rawStageBytes'] and digest(raw) == S['rawStageSHA256']
    assert git('rev-parse', 'HEAD').decode().strip() == S['head']
    assert git('rev-parse', 'HEAD^{tree}').decode().strip() == S['tree']
    assert digest(git('cat-file', 'commit', 'HEAD')) == S['commitSHA256']
    assert git('write-tree').decode().strip() == S['tree']
    index = {}
    for record in raw.split(b'\0'):
        if record:
            meta, path = record.split(b'\t')
            mode, oid, stage = meta.decode().split()
            assert stage == '0'
            index[path.decode()] = (mode, oid)
    assert set(index) == {row['path'] for row in rows}
    assert len(rows) == S['fileCount'] == 1418
    for row in rows:
        path = R / row['path']
        assert index[row['path']] == (row['mode'], row['indexOid'])
        mode = path.lstat().st_mode
        if row['kind'] == 'symlink':
            assert stat.S_ISLNK(mode)
            data = os.readlink(path).encode()
        else:
            assert row['kind'] == 'file' and stat.S_ISREG(mode), row['path']
            assert bool(mode & 0o111) == (row['mode'] == '100755'), row['path']
            data = path.read_bytes()
        assert len(data) == row['bytes'] and digest(data) == row['sha256'], row['path']
    assert digest((R / 'src/clawsweeper-change-detection.ts').read_bytes()) == S['classifierSHA256']
    assert digest((R / S['recipePath']).read_bytes()) == S['recipeSHA256']
    assert S['productOverlay'] is False and S['changedPaths'] == []
    return {'head': S['head'], 'tree': S['tree'], 'files': len(rows), 'stageSHA256': digest(raw)}

def inventory(root):
    result = {}
    if not root.exists():
        return result
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                continue
            key = str(path.relative_to(root))
            if stat.S_ISLNK(mode):
                result[key] = {'kind': 'symlink', 'target': os.readlink(path)}
            else:
                assert stat.S_ISREG(mode), key
                data = path.read_bytes()
                result[key] = {'kind': 'file', 'bytes': len(data), 'sha256': digest(data)}
    return result

def snapshot():
    return {'source': bind_source(), 'inputs': bind_inputs(),
            'dependencies': inventory(R / 'node_modules'), 'build': inventory(R / 'dist'),
            'corepack': inventory(O.parent / 'corepack'),
            'nodeSHA256': digest(Path(shutil.which('node')).resolve().read_bytes())}

def child_environment():
    # Source commands receive only the explicit tool path and fresh task-owned HOME.
    home = O.parent / 'home'
    home.mkdir(exist_ok=True)
    return {'PATH': os.environ['PATH'], 'HOME': str(home), 'CI': '1',
            'LANG': 'C.UTF-8', 'TZ': 'UTC', 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0',
            'COREPACK_HOME': str(O.parent / 'corepack')}

def run(name, argv, timeout, env, *, allow_incomplete=False):
    row = {'name': name, 'argv': argv, 'timeoutSeconds': timeout, 'startedAt': time.time(), 'timedOut': False}
    with (O / (name + '.stdout')).open('xb') as out, (O / (name + '.stderr')).open('xb') as err:
        child = subprocess.Popen(argv, cwd=R, env=env, stdout=out, stderr=err, start_new_session=True)
        row['pid'] = child.pid
        try:
            row['exitCode'] = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            row['timedOut'] = True
        def group_exists():
            try:
                os.killpg(child.pid, 0)
                return True
            except ProcessLookupError:
                return False
        row['residualGroup'] = child.poll() is not None and group_exists()
        row['cleanupSignals'] = []
        if group_exists():
            for sig in [signal.SIGTERM, signal.SIGKILL]:
                if not group_exists():
                    break
                os.killpg(child.pid, sig)
                row['cleanupSignals'].append(sig.name)
                if sig == signal.SIGTERM:
                    deadline = time.monotonic() + 5
                    while group_exists() and time.monotonic() < deadline:
                        child.poll()
                        time.sleep(0.05)
        row['exitCode'] = child.wait()
        row['reaped'] = True
        row['processGroupAbsent'] = not group_exists()
    row['endedAt'] = time.time()
    save(O / (name + '.command.json'), row)
    assert row['reaped'] and row['processGroupAbsent'] and not row['residualGroup'], name
    if not allow_incomplete:
        assert not row['timedOut'], name
    return row

def prepare():
    O.mkdir(parents=True)
    # A nonzero config query means no retained checkout credential header.
    headers = subprocess.run(['git', 'config', '--get-regexp', '^http\\..*\\.extraheader$'], cwd=R, capture_output=True)
    assert headers.returncode == 1, 'Checkout credential header present or query failed'
    assert not git('status', '--porcelain=v1', '--untracked-files=all').strip()
    bind_inputs()
    source = bind_source()
    assert not git('diff', '--cached', '--name-only', '-z', 'HEAD')
    assert json.loads((R / 'package.json').read_text())['packageManager'] == S['packageManager']
    save(O / 'source.json', {'publicMain': source, 'changedPaths': [], 'productOverlay': False,
         'controlSHA': os.environ['PROOF_CONTROL_SHA'], 'workflowSHA': os.environ['PROOF_WORKFLOW_SHA'],
         'runId': os.environ['PROOF_RUN_ID'], 'runAttempt': os.environ['PROOF_RUN_ATTEMPT'],
         'scope': S['scope'], 'inputManifestSHA256': bind_inputs()})

def verify_recipe(value, phase, built, contract):
    assert value['mode'] == 'candidate' and value['scenarioCount'] == 24
    assert [{'name': row['name'], 'expected': row['expected']} for row in value['results']] == contract['scenarios']
    checks = {'persistedClassification', 'persistedSurfaces', 'persistedWarning', 'provedPersistedWarning',
              'compatibilityGate', 'humanVerdict', 'passVerdict', 'sqliteFilesMatchClassification',
              'sqliteWarningMatchesClassification', 'provedSqliteWarningMatchesClassification',
              'negativeHasNoSqliteClassification', 'negativeHasNoSqliteWarning', 'compatibilityProofAccepted'}
    for row in value['results']:
        assert isinstance(row['failedChecks'], list) and len(row['failedChecks']) == len(set(row['failedChecks']))
        assert set(row['failedChecks']) <= checks
    failed = [row['name'] for row in value['results'] if row['failedChecks']]
    assert value['failures'] == failed
    assert value['passed'] is (not failed) and value['expectedOutcomeObserved'] is (not failed)
    assert value['controlsPassed'] is all(not row['failedChecks'] for row in value['results'] if row['expected'])
    assert phase['exitCode'] == (1 if failed else 0)
    provenance = value['provenance']
    assert provenance['sourceHead'] == S['head'] and provenance['sourceWorkingDiffSha256'] == digest(b'')
    assert provenance['script'] == {'path': S['recipePath'], 'sha256': S['recipeSHA256']}
    assert provenance['detector'] == {'inputKind': 'compiled candidate JavaScript', 'inputSha256': built['build']['clawsweeper-change-detection.js']['sha256']}
    sources = {row['path']: row for row in S['source']}
    assert provenance['sourceHashes'] == {path: sources[path]['sha256'] for path in contract['sourceOwners']}
    assert provenance['compiledHashes'] == {path: built['build'][path.removeprefix('dist/')]['sha256'] for path in contract['compiledOwners']}
    assert provenance['fixture']['path'] == contract['fixture']['path']
    assert provenance['fixture']['sha256'] == contract['fixture']['sha256']
    assert provenance['environment'] == {'provider': 'local-node', 'node': 'v24.19.0', 'platform': 'linux', 'arch': 'x64', 'image': None, 'lease': None}
    return failed

def execute():
    result = {'exitCode': 2, 'recipeComplete': False, 'originalsComplete': False,
              'recipeAllPassed': False, 'originalsAllPassed': False, 'observedCount': 0,
              'recipe': {'status': 'unattempted', 'exitCode': None}, 'originals': [],
              'sourceTree': S['tree'], 'classifierSHA256': S['classifierSHA256'],
              'productOverlay': False, 'fullSuiteExecuted': False, 'startedAt': time.time()}
    try:
        bind_inputs()
        bind_source()
        node = str(Path(shutil.which('node')).resolve())
        env = child_environment()
        assert subprocess.check_output([node, '--version'], env=env, text=True, timeout=15).strip() == 'v24.19.0'
        assert not (R / 'node_modules').exists() and not (R / 'dist').exists()
        corepack_sibling = Path(node).parent / 'corepack'
        assert corepack_sibling.is_file(), 'Pinned Node distribution lacks Corepack'
        corepack = str(corepack_sibling.resolve())
        phase = run('pnpm-prepare', [node, corepack, 'prepare', 'pnpm@11.10.0', '--activate'], 120, env)
        assert phase['exitCode'] == 0
        pnpm = [node, corepack, 'pnpm']
        version = subprocess.check_output(pnpm + ['--version'], cwd=R, env=env, text=True, timeout=15).strip()
        assert version == '11.10.0'
        save(O / 'runtime.json', {'node': 'v24.19.0', 'pnpm': version, 'nodeSHA256': digest(Path(node).read_bytes()),
                                 'sourceEnvironmentKeys': sorted(env), 'githubHosted': True})
        initial = snapshot()
        save(O / 'initial-inventory.json', initial)
        phase = run('install', pnpm + ['install', '--frozen-lockfile'], 180, env)
        assert phase['exitCode'] == 0
        installed = snapshot()
        save(O / 'installed-inventory.json', installed)
        for key in ['source', 'inputs', 'corepack', 'nodeSHA256']:
            assert installed[key] == initial[key], key
        assert installed['dependencies'] and not installed['build']
        phase = run('build', pnpm + ['run', 'build'], 120, env)
        assert phase['exitCode'] == 0
        built = snapshot()
        save(O / 'built-inventory.json', built)
        for key in ['source', 'inputs', 'dependencies', 'corepack', 'nodeSHA256']:
            assert built[key] == installed[key], key
        contract = json.loads((P / 'recipe-contract.json').read_text())
        assert contract['mode'] == 'candidate' and contract['scenarioCount'] == 24
        assert contract['recipeTimeoutSeconds'] == 120 and contract['originalTimeoutSeconds'] == 15 and contract['heapMiB'] == 512
        for path in contract['compiledOwners']:
            row = built['build'][path.removeprefix('dist/')]
            assert row['kind'] == 'file' and row['bytes'] > 0
        cases = json.loads((P / 'cases.json').read_text())
        assert len(cases) == contract['originalCount'] == 4 and len({c['name'] for c in cases}) == 4
        result['originals'] = [{'name': case['name'], 'ordinal': ordinal, 'status': 'unattempted', 'exitCode': None}
                               for ordinal, case in enumerate(cases)]
        result['recipe']['status'] = 'running'
        save(O / 'result.json', result)
        # Execute the repository's exact recipe unchanged, in candidate mode (no --baseline).
        phase = run('recipe', [node, '--max-old-space-size=512', str(R / S['recipePath'])], 120, env, allow_incomplete=True)
        result['recipe']['exitCode'] = phase['exitCode']
        try:
            assert not phase['timedOut'] and not phase['residualGroup']
            value = json.loads((O / 'recipe.stdout').read_text())
            failed = verify_recipe(value, phase, built, contract)
            result['recipe'].update(status='complete', scenarioCount=24, failedNames=failed,
                                    observedSHA256=digest((O / 'recipe.stdout').read_bytes()))
        except Exception as error:
            result['recipe'].update(status='incomplete', error={'type': type(error).__name__, 'message': str(error)})
        finally:
            save(O / 'result.json', result)
        # Independent originals may continue after a closed recipe failure, never after state drift.
        assert snapshot() == built, 'recipe'
        result['recipe']['sourceDependencyToolBuildPreserved'] = True
        result['recipeComplete'] = result['recipe']['status'] == 'complete'
        result['recipeAllPassed'] = result['recipeComplete'] and result['recipe']['exitCode'] == 0
        save(O / 'result.json', result)
        for ordinal, case in enumerate(cases):
            label = f'original-{ordinal:02d}'
            output = O / (label + '.observed.json')
            row = result['originals'][ordinal]
            row['status'] = 'running'
            save(O / 'result.json', result)
            phase = run(label, [node, '--max-old-space-size=512', str(P / 'original-four.mjs'), str(R), str(P), str(ordinal), str(output)], 15, env, allow_incomplete=True)
            row['exitCode'] = phase['exitCode']
            try:
                assert not phase['timedOut'] and not phase['residualGroup'], label
                value = json.loads(output.read_text())
                assert value['name'] == case['name'] and value['ordinal'] == ordinal
                assert value['mode'] == case['mode'] and value['expected'] == case['expected']
                assert isinstance(value['failures'], list) and isinstance(value['rendered'], str)
                assert isinstance(value['markers'], dict) and isinstance(value['pullFiles'], list)
                assert value['passed'] is (not value['failures'])
                assert phase['exitCode'] == (1 if value['failures'] else 0)
                assert value['provenance']['sourceHead'] == S['head']
                row.update(status='complete', assertionFailureCount=len(value['failures']), observedSHA256=digest(output.read_bytes()))
            except Exception as error:
                row.update(status='incomplete', error={'type': type(error).__name__, 'message': str(error)})
            finally:
                save(O / 'result.json', result)
            assert snapshot() == built, label
            row['sourceDependencyToolBuildPreserved'] = True
            save(O / 'result.json', result)
        final = snapshot()
        save(O / 'final-inventory.json', final)
        assert final == built
        result['originalsComplete'] = all(row['status'] == 'complete' for row in result['originals'])
        result['originalsAllPassed'] = result['originalsComplete'] and all(row['exitCode'] == 0 for row in result['originals'])
        result['observedCount'] = (24 if result['recipeComplete'] else 0) + sum(row['status'] == 'complete' for row in result['originals'])
        result['sourceDependencyToolBuildPreserved'] = True
        if result['recipeComplete'] and result['originalsComplete']:
            result['exitCode'] = 0 if result['recipeAllPassed'] and result['originalsAllPassed'] else 1
    except BaseException as error:
        # Exception type/message only; never dump environment or arbitrary filesystem state.
        result['error'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        for row in [result['recipe']] + result['originals']:
            if row.get('status') == 'running':
                row.update(status='incomplete', error=result.get('error'))
            elif row.get('status') == 'unattempted':
                row['reason'] = result.get('error')
        result['endedAt'] = time.time()
        save(O / 'result.json', result)
    return result['exitCode']

def collect():
    # Upload only this diagnostic's explicit observations and bounded command logs.
    bind_inputs()
    publish = O.parent / 'publish'
    publish.mkdir()
    allowed = {'source.json', 'runtime.json', 'result.json', 'initial-inventory.json', 'installed-inventory.json', 'built-inventory.json', 'final-inventory.json'}
    for label in ['pnpm-prepare', 'install', 'build', 'recipe'] + [f'original-{i:02d}' for i in range(4)]:
        allowed.update(label + suffix for suffix in ['.stdout', '.stderr', '.command.json'])
        if label.startswith('original-'):
            allowed.add(label + '.observed.json')
    assert O.is_dir() and not O.is_symlink()
    files = list(O.iterdir())
    assert files and {f.name for f in files} <= allowed
    manifest = []
    total = 0
    for path in sorted(files):
        assert stat.S_ISREG(path.lstat().st_mode), path.name
        data = path.read_bytes()
        total += len(data)
        assert total <= 50_000_000 and len(data) <= 30_000_000
        shutil.copyfile(path, publish / path.name)
        manifest.append({'name': path.name, 'bytes': len(data), 'sha256': digest(data)})
    save(publish / 'artifact-manifest.json', {'files': manifest, 'scope': S['scope']})

if sys.argv[1] == 'prepare':
    prepare()
elif sys.argv[1] == 'execute':
    raise SystemExit(execute())
elif sys.argv[1] == 'collect':
    collect()
else:
    raise ValueError('Expected prepare, execute, or collect')
