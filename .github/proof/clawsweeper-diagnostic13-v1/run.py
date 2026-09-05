"""Held hosted diagnostic: bind candidate, build once, observe AFTER9 and BEFORE4."""
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

def bind_source(candidate):
    rows = S['hostSource'] if candidate else S['baseSource']
    raw = git('ls-files', '--stage', '-z')
    prefix = 'candidate' if candidate else 'base'
    assert len(raw) == S[prefix + 'RawStageBytes']
    assert digest(raw) == S[prefix + 'RawStageSHA256']
    assert git('rev-parse', 'HEAD').decode().strip() == S['baseHead']
    assert git('rev-parse', 'HEAD^{tree}').decode().strip() == S['baseTree']
    assert digest(git('cat-file', 'commit', 'HEAD')) == S['baseCommitSHA256']
    assert git('write-tree').decode().strip() == S['candidateTree' if candidate else 'baseTree']
    index = {}
    for record in raw.split(b'\0'):
        if record:
            meta, path = record.split(b'\t')
            mode, oid, stage = meta.decode().split()
            assert stage == '0'
            index[path.decode()] = (mode, oid)
    assert set(index) == {row['path'] for row in rows}
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
    if candidate:
        assert len(rows) == 1404
        assert digest((R / 'src/clawsweeper-change-detection.ts').read_bytes()) == S['classifierSHA256']
    return {'head': S['baseHead'], 'tree': S['candidateTree' if candidate else 'baseTree'], 'files': len(rows), 'stageSHA256': digest(raw)}

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
    return {'source': bind_source(True), 'inputs': bind_inputs(),
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
    before = bind_source(False)
    assert digest((P / 'reconstruct.patch').read_bytes()) == S['patchSHA256']
    git('apply', '--check', str(P / 'reconstruct.patch'))
    git('apply', '--index', str(P / 'reconstruct.patch'))
    after = bind_source(True)
    changed = git('diff', '--cached', '--name-only', '-z', 'HEAD').decode().rstrip('\0').split('\0')
    assert sorted(changed) == sorted(S['changedPaths']) and len(changed) == 13
    assert json.loads((R / 'package.json').read_text())['packageManager'] == 'pnpm@11.10.0'
    save(O / 'source.json', {'base': before, 'candidate': after, 'changedPaths': changed,
         'controlSHA': os.environ['PROOF_CONTROL_SHA'], 'workflowSHA': os.environ['PROOF_WORKFLOW_SHA'],
         'runId': os.environ['PROOF_RUN_ID'], 'runAttempt': os.environ['PROOF_RUN_ATTEMPT'],
         'scope': S['scope'], 'inputManifestSHA256': bind_inputs()})

def execute():
    result = {'exitCode': 2, 'afterComplete': False, 'beforeComplete': False,
              'afterAllPassed': False, 'beforeDifferences': 0, 'after': [], 'before': [],
              'sourceTree': S['candidateTree'], 'classifierSHA256': S['classifierSHA256'],
              'sameCandidateBothLanes': True, 'full350Executed': False, 'startedAt': time.time()}
    try:
        bind_inputs()
        bind_source(True)
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
        phase = run('install', pnpm + ['install', '--frozen-lockfile'], 180, env)
        assert phase['exitCode'] == 0
        installed = snapshot()
        for key in ['source', 'inputs', 'corepack', 'nodeSHA256']:
            assert installed[key] == initial[key], key
        assert installed['dependencies'] and not installed['build']
        phase = run('build', pnpm + ['run', 'build'], 120, env)
        assert phase['exitCode'] == 0
        built = snapshot()
        for key in ['source', 'inputs', 'dependencies', 'corepack', 'nodeSHA256']:
            assert built[key] == installed[key], key
        for name in ['clawsweeper.js', 'clawsweeper-change-detection.js', 'review-activity-cursor.js']:
            assert built['build'][name]['kind'] == 'file' and built['build'][name]['bytes'] > 0
        save(O / 'built-inventory.json', built)
        cases_by_lane = {lane: json.loads((P / filename).read_text()) for lane, filename in [('after','after9-cases.json'),('before','before4-cases.json')]}
        assert [len(cases_by_lane[k]) for k in ['after','before']] == [9,4]
        assert len({c['name'] for rows in cases_by_lane.values() for c in rows}) == 13
        for lane in ['after', 'before']:
            result[lane] = [{'name': case['name'], 'ordinal': ordinal, 'status': 'unattempted', 'exitCode': None}
                            for ordinal, case in enumerate(cases_by_lane[lane])]
        save(O / 'result.json', result)
        for lane, filename in [('after','after9-cases.json'),('before','before4-cases.json')]:
            for ordinal, case in enumerate(cases_by_lane[lane]):
                label = f'{lane}-{ordinal:02d}'
                output = O / (label + '.observed.json')
                row = result[lane][ordinal]
                row['status'] = 'running'
                save(O / 'result.json', result)
                # Only a reaped, closed process group may return for per-case recovery.
                phase = run(label, [node, '--max-old-space-size=512', str(P / 'probe.mjs'), str(R), str(P / filename), str(ordinal), str(output)], 15, env, allow_incomplete=True)
                row['exitCode'] = phase['exitCode']
                try:
                    assert not phase['timedOut'] and not phase['residualGroup'], label
                    value = json.loads(output.read_text())
                    assert value['name'] == case['name']
                    assert value['expected'] == {'change': bool(case['expectedSurfaces']), 'surfaces': case['expectedSurfaces']}
                    assert isinstance(value['assertionFailures'], list)
                    assert all(isinstance(value[k], str) for k in ['report','renderedWarning','markers'])
                    assert phase['exitCode'] == (1 if value['assertionFailures'] else 0)
                    row.update(status='complete', assertionFailureCount=len(value['assertionFailures']), observedSHA256=digest(output.read_bytes()))
                except Exception as error:
                    row.update(status='incomplete', error={'type': type(error).__name__, 'message': str(error)})
                finally:
                    save(O / 'result.json', result)
                # A failed observation is independent only while every frozen owner is unchanged.
                assert snapshot() == built, label
                row['sourceDependencyToolBuildPreserved'] = True
                save(O / 'result.json', result)
            result[lane + 'Complete'] = all(row['status'] == 'complete' for row in result[lane])
        result['afterAllPassed'] = result['afterComplete'] and all(row['exitCode'] == 0 for row in result['after'])
        result['beforeDifferences'] = sum(row['status'] == 'complete' and row['exitCode'] == 1 for row in result['before'])
        result['sourceDependencyToolBuildPreserved'] = True
        if result['afterComplete'] and result['beforeComplete']:
            result['exitCode'] = 0 if result['afterAllPassed'] and result['beforeDifferences'] == 0 else 1
    except BaseException as error:
        # Exception type/message only; never dump environment or arbitrary filesystem state.
        result['error'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        for row in result['after'] + result['before']:
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
    allowed = {'source.json', 'runtime.json', 'result.json', 'built-inventory.json'}
    for label in ['pnpm-prepare', 'install', 'build'] + [f'{lane}-{i:02d}' for lane,n in [('after',9),('before',4)] for i in range(n)]:
        allowed.update(label + suffix for suffix in ['.stdout', '.stderr', '.command.json'])
        if label.startswith(('after-', 'before-')):
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
