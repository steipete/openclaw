"""One fixed before/after proof on a secretless, ephemeral GitHub-hosted runner."""
from pathlib import Path
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

os.umask(0o077)
assets = Path(__file__).resolve().parent
revision, root_arg, output_arg = sys.argv[1:]
assert revision in {'baseline', 'candidate'}
root, output = Path(root_arg).resolve(), Path(output_arg).resolve()
output.mkdir(mode=0o700, parents=True, exist_ok=False)
receipt = {'passed': False, 'revision': revision, 'phase': 'preflight', 'commands': []}
scratch = None
overlay = None

def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()

def save(name, value):
    (output / name).write_text(json.dumps(value, indent=2) + '\n')

def git(*args):
    return subprocess.check_output(['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=root, text=True).strip()

def run(name, argv, cwd, env, timeout):
    receipt['phase'] = name
    started = time.monotonic()
    result = {'argv': argv, 'exitCode': None}
    try:
        with (output / (name + '.stdout')).open('wb') as out, (output / (name + '.stderr')).open('wb') as err:
            child = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=out, stderr=err, timeout=timeout, check=False)
        result['exitCode'] = child.returncode
        return child.returncode
    finally:
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append({'name': name, **result})
        save(name + '-result.json', result)

def check_sources():
    assert git('rev-parse', 'HEAD') == expected['head']
    assert git('rev-parse', 'HEAD^{tree}') == binding[revision]['tree']
    assert git('remote', 'get-url', 'origin') == 'https://github.com/openclaw/openclaw'
    for args in [('diff', '--no-ext-diff', '--quiet'), ('diff', '--cached', '--no-ext-diff', '--quiet')]:
        subprocess.run(['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=root, check=True)
    for name, sha in expected['files'].items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert re.fullmatch('[a-f0-9]{64}', sha) and digest(root / name) == sha, name
    credentials = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp',
                                  '(extraheader|credential)'], cwd=root, capture_output=True, text=True)
    assert credentials.returncode == 1 and not credentials.stdout

try:
    assert platform.system() == 'Linux' and os.environ['RUNNER_ENVIRONMENT'] == 'github-hosted'
    assert os.environ['GITHUB_REPOSITORY'] == 'steipete/openclaw'
    assert os.environ['GITHUB_EVENT_NAME'] == 'push'
    binding = json.loads((assets / 'execution-binding.json').read_text())
    assert os.environ['GITHUB_REF'] == 'refs/heads/' + binding['branch']
    proof_root = assets.parents[2]
    assert subprocess.check_output(['/usr/bin/git', 'rev-parse', 'HEAD'], cwd=proof_root, text=True).strip() == os.environ['GITHUB_SHA']
    for name, sha in json.loads((assets / 'assets-manifest.json').read_text()).items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(proof_root / name) == sha, name
    for mode in ['baseline', 'candidate']:
        assert re.fullmatch('[a-f0-9]{40}', binding[mode]['head'] or '')
        assert re.fullmatch('[a-f0-9]{40}', binding[mode]['tree'] or '')
    expected = json.loads((assets / (revision + '-manifest.json')).read_text())
    assert expected['head'] == binding[revision]['head']
    assert digest(assets / 'permanent.test.ts') == binding['testSHA256']
    test_path = binding['testPath']
    assert test_path == 'src/agents/subagents/registry/subagent-registry-completion-runtime.test.ts'
    check_sources()
    assert json.loads((root / 'package.json').read_text())['packageManager'] == binding['packageManager']
    assert not (root / 'node_modules').exists(), 'Require an ordinary fresh dependency installation'
    node = str(Path(shutil.which('node')).resolve())
    assert subprocess.check_output([node, '--version'], text=True).strip() == 'v24.19.0'
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file(), 'Use bundled Corepack'
    scratch = Path(tempfile.mkdtemp(prefix='completion-proof-', dir=output.parent))
    for name in ['home', 'bin', 'corepack', 'tmp', 'config', 'cache', 'data']:
        (scratch / name).mkdir(mode=0o700)
    child_env = {'PATH': str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin',
                 'HOME': str(scratch / 'home'), 'CI': '1', 'COREPACK_HOME': str(scratch / 'corepack'),
                 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'TMPDIR': str(scratch / 'tmp'),
                 'XDG_CONFIG_HOME': str(scratch / 'config'), 'XDG_CACHE_HOME': str(scratch / 'cache'),
                 'XDG_DATA_HOME': str(scratch / 'data')}
    save('source-before.json', {'head': expected['head'], 'tree': binding[revision]['tree'],
         'files': expected['files'], 'testSHA256': binding['testSHA256'],
         'proofCommit': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
         'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'runner': os.environ['RUNNER_ENVIRONMENT'],
         'childEnvNames': sorted(child_env)})
    assert run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], scratch, child_env, 300) == 0
    assert run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], scratch, child_env, 300) == 0
    pnpm = str(scratch / 'bin/pnpm')
    assert run('pnpm-version', [pnpm, '--version'], scratch, child_env, 300) == 0
    assert (output / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    assert run('install', [pnpm, 'install', '--frozen-lockfile'], root, child_env, 1200) == 0
    check_sources()
    installed_lock_sha = digest(root / 'node_modules/.pnpm/lock.yaml')
    save('installed-dependencies.json', {'lockSHA256': installed_lock_sha})
    if revision == 'baseline':
        assert not (root / test_path).exists()
        assert git('ls-files', '--', test_path) == ''
        overlay = root / test_path
        overlay.write_bytes((assets / 'permanent.test.ts').read_bytes())
    assert digest(root / test_path) == binding['testSHA256']
    code = run('unit', [node, 'scripts/run-vitest.mjs', 'run', test_path,
                       '--reporter=default', '--reporter=json', '--outputFile=' + str(output / 'vitest.json')],
               root, child_env, 1200)
    report = json.loads((output / 'vitest.json').read_text())
    assert len(report['testResults']) == 1 and Path(report['testResults'][0]['name']).resolve() == root / test_path
    cases = report['testResults'][0]['assertionResults']
    grace = {"contains the " + kind + " grace callback's escaped rejection" for kind in ['error', 'timeout', 'cancellation']}
    controls = {
        'propagates the same escaped error to an awaited caller',
        'retains the restart-retry diagnostic and retires the fired timer',
        'rejects a stale restart timer after replacement', 'rejects a stale restart timer after generation',
        'stops after successful attempt 1 without starting cleanup recovery',
        'stops after successful attempt 2 without starting cleanup recovery',
        'stops retrying when the failed attempt removes the row',
        'preserves running recovery after both attempts fail', 'preserves cleaned recovery after both attempts fail',
        'preserves yielded recovery after both attempts fail',
    }
    save('unit-observed.json', {'exitCode': code, 'cases': cases, 'numTotalTests': report['numTotalTests'],
                              'numPassedTests': report['numPassedTests'], 'numFailedTests': report['numFailedTests']})
    assert len(cases) == report['numTotalTests'] == 13
    assert {case['title'] for case in cases} == grace | controls
    assert report['numPendingTests'] == report['numTodoTests'] == 0
    console = re.sub(r'\x1b\[[0-9;]*m', '', (output / 'unit.stdout').read_text() + (output / 'unit.stderr').read_text())
    before = revision == 'baseline'
    assert code == (1 if before else 0)
    assert report['numFailedTests'] == (3 if before else 0)
    assert report['numPassedTests'] == (10 if before else 13)
    assert report['success'] is (not before)
    for case in cases:
        failed = before and case['title'] in grace
        assert case['status'] == ('failed' if failed else 'passed'), case['title']
        if failed:
            assert 'failed to complete subagent run in background' in '\n'.join(case['failureMessages'])
    assert console.count('Unhandled Rejection') == (3 if before else 0)
    if before:
        assert 'synthetic resume failure' in console
    else:
        assert run('process', [node, str(assets / 'run-completion-proof.mjs'), str(root),
                   str(assets / 'candidate-manifest.json'), 'candidate', str(output / 'process')], root, child_env, 120) == 0
        assert json.loads((output / 'process/receipt.json').read_text())['passed'] is True
    check_sources()
    assert digest(root / test_path) == binding['testSHA256']
    assert digest(root / 'node_modules/.pnpm/lock.yaml') == installed_lock_sha
    save('source-after.json', expected)
    receipt.update(passed=True, phase='complete', head=expected['head'], tree=binding[revision]['tree'])
except Exception as error:
    receipt['error'] = str(error)
    (output / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        if overlay is not None:
            assert not overlay.is_symlink() and digest(overlay) == binding['testSHA256']
            assert git('ls-files', '--', binding['testPath']) == ''
            overlay.unlink()
        if scratch is not None:
            shutil.rmtree(scratch)
    except Exception as error:
        receipt.update(passed=False, cleanupError=str(error))
    save('hosted-proof-result.json', receipt)
    print(json.dumps({'revision': revision, 'passed': receipt['passed'], 'phase': receipt['phase']}))
sys.exit(0 if receipt['passed'] else 1)
