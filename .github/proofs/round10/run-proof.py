"""Run one fixed proof on an ephemeral GitHub-hosted runner; retain failure data."""
from pathlib import Path
import base64
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import traceback

os.umask(0o077)
assets = Path(__file__).resolve().parent
pr, candidate_arg, evidence_arg = sys.argv[1:]
assert pr in {'127959', '132266'}
candidate = Path(candidate_arg).resolve()
evidence = Path(evidence_arg).resolve()
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
receipt = {'passed': False, 'pr': pr, 'phase': 'setup', 'commands': [], 'cleanupErrors': []}
scratch = None
binding = None

def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()

def save(name, value):
    (evidence / name).write_text(json.dumps(value, indent=2) + '\n')

def git(root, *args):
    return subprocess.check_output(['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=root, text=True).strip()

def run(name, argv, cwd, env, timeout):
    receipt['phase'] = name
    started = time.monotonic()
    result = {'name': name, 'argv': argv, 'exitCode': None}
    try:
        with (evidence / (name + '.stdout')).open('wb') as out, (evidence / (name + '.stderr')).open('wb') as err:
            child = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=timeout, check=False)
        result['exitCode'] = child.returncode
        return child.returncode
    finally:
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(name + '-result.json', result)

def check_candidate():
    assert git(candidate, 'rev-parse', 'HEAD') == binding['candidateHead']
    assert git(candidate, 'rev-parse', 'HEAD^{tree}') == binding['candidateTree']
    assert git(candidate, 'remote', 'get-url', 'origin') == 'https://github.com/openclaw/openclaw'
    for args in [('diff', '--no-ext-diff', '--quiet'), ('diff', '--cached', '--no-ext-diff', '--quiet')]:
        subprocess.run(['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=candidate, check=True)
    for name, expected in binding['candidateFileSHA256'].items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(candidate / name) == expected, name
    # Checkout's read token must not persist into any executed candidate phase.
    credential_keys = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp', '(extraheader|credential)'], cwd=candidate, capture_output=True, text=True)
    assert credential_keys.returncode == 1 and not credential_keys.stdout

try:
    assert platform.system() == 'Linux'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-secretless-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert candidate.name == 'candidate' and candidate.is_dir()
    proof_checkout = assets.parents[2]
    assert git(proof_checkout, 'rev-parse', 'HEAD') == os.environ['GITHUB_SHA']
    manifest = json.loads((assets / 'manifest.json').read_text())
    for name, expected in manifest['sha256'].items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(proof_checkout / name) == expected, name
    packet = assets / pr
    binding = json.loads((packet / 'execution-binding.json').read_text())
    assert binding['provider'] == 'github-actions' and binding['executionEnvironment'] == 'github-hosted'
    assert digest(packet / 'proof.test.ts') == binding['proofTestSHA256']
    assert digest(packet / 'proof-driver.mjs') == binding['driverSHA256']
    assert digest(packet / 'extract-and-assess.py') == binding['extractorSHA256']
    if pr == '132266':
        assert digest(packet / 'metadata-after.mjs') == binding['metadataHarnessSHA256']
    check_candidate()
    assert json.loads((candidate / 'package.json').read_text())['packageManager'] == binding['packageManager']
    assert not (candidate / 'node_modules').exists(), 'Require a fresh dependency installation'
    assert not Path(binding['remoteArchive']).exists(), 'Refuse an earlier proof archive'
    node = shutil.which('node')
    assert node is not None
    node = str(Path(node).resolve())
    assert subprocess.check_output([node, '--version'], text=True).strip() == 'v24.19.0'
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file(), 'Canonical Node 24 distribution must supply Corepack'
    scratch = evidence.parent / ('round10-runtime-' + pr)
    scratch.mkdir(mode=0o700, exist_ok=False)
    for name in ['home', 'corepack', 'bin', 'tmp', 'config', 'cache', 'data']:
        (scratch / name).mkdir(mode=0o700)
    environment_path = str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin'
    child_env = {'PATH': environment_path, 'HOME': str(scratch / 'home'), 'CI': '1', 'COREPACK_HOME': str(scratch / 'corepack'), 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'TMPDIR': str(scratch / 'tmp'), 'XDG_CONFIG_HOME': str(scratch / 'config'), 'XDG_CACHE_HOME': str(scratch / 'cache'), 'XDG_DATA_HOME': str(scratch / 'data')}
    provenance_keys = ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']
    binding.update(nodeExecutable=node, environmentPath=environment_path, corepackHome=child_env['COREPACK_HOME'], hostedProvenance={key: os.environ[key] for key in provenance_keys})
    save('execution-binding.json', binding)
    save('bootstrap-source.json', {'candidateHead': binding['candidateHead'], 'candidateTree': binding['candidateTree'], 'sourceFileCount': binding['sourceFileCount'], 'sourceHashes': binding['candidateFileSHA256'], 'proofAssetsCommit': os.environ['GITHUB_SHA'], 'manifestSHA256': digest(assets / 'manifest.json'), 'nodeExecutable': node, 'nodeVersion': '24.19.0', 'packageManager': binding['packageManager'], 'childEnvNames': sorted(child_env), 'hostedProvenance': binding['hostedProvenance']})
    assert run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], scratch, child_env, 300) == 0
    assert run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], scratch, child_env, 300) == 0
    pnpm = str(scratch / 'bin/pnpm')
    assert run('pnpm-version', [pnpm, '--version'], scratch, child_env, 300) == 0
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    assert run('install', [pnpm, 'install', '--frozen-lockfile'], candidate, child_env, 1200) == 0
    check_candidate()
    driver_args = [binding['candidateHead'], json.dumps(binding, separators=(',', ':')), base64.b64encode((packet / 'proof.test.ts').read_bytes()).decode()]
    if pr == '132266':
        driver_args.append(base64.b64encode((packet / 'metadata-after.mjs').read_bytes()).decode())
    # Eval retains the reviewed driver's argv contract; only reviewed fixture bytes are embedded.
    argv = [node, '--input-type=module', '-e', (packet / 'proof-driver.mjs').read_text(), *driver_args]
    # Avoid duplicating the embedded source/base64 in command receipts; files are already hash-bound.
    receipt['phase'] = 'proof'
    started = time.monotonic()
    with (evidence / 'remote.stdout').open('wb') as out, (evidence / 'remote.stderr').open('wb') as err:
        proof = subprocess.run(argv, cwd=candidate, env=child_env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=3600, check=False)
    save('proof-process-result.json', {'exitCode': proof.returncode, 'seconds': round(time.monotonic() - started, 3), 'driverSHA256': binding['driverSHA256']})
    prefix = 'GATEWAY_QUOTE_PROOF_RECEIPT ' if pr == '127959' else 'TOOL_METADATA_PROOF_RECEIPT '
    rows = [json.loads(line[len(prefix):]) for line in (evidence / 'remote.stdout').read_text().splitlines() if line.startswith(prefix)]
    assert len(rows) == 1, 'Require one terminal proof receipt'
    terminal = rows[0]
    if terminal.get('artifact') is not None:
        assert terminal['artifact'] == binding['remoteArchive']
        archive = Path(terminal['artifact'])
        assert archive.is_file() and not archive.is_symlink()
        assert archive.stat().st_size == terminal['artifactBytes'] <= 65 * 1024 * 1024
        assert digest(archive) == terminal['artifactSHA256']
        shutil.copyfile(archive, evidence / ('proof-success.tgz' if terminal.get('passed') else 'proof-failure.tgz'))
    shutil.copyfile(packet / 'extract-and-assess.py', evidence / 'extract-and-assess.py')
    assert digest(evidence / 'extract-and-assess.py') == binding['extractorSHA256']
    assessed = run('assess', ['/usr/bin/python3', str(evidence / 'extract-and-assess.py')], evidence, child_env, 120)
    check_candidate()
    assert assessed == 0 and proof.returncode == 0 and terminal.get('passed') is True
    assert terminal.get('fullProofCompleted') is True
    receipt.update(passed=True, phase='complete', candidateHead=binding['candidateHead'], candidateTree=binding['candidateTree'])
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    # The runner is ephemeral; additionally remove only our untracked proof overlay and private HOME.
    try:
        if binding:
            overlay = candidate / binding['proofTestRemotePath']
            if overlay.exists():
                assert not overlay.is_symlink() and digest(overlay) == binding['proofTestSHA256']
                tracked = subprocess.run(['/usr/bin/git', 'ls-files', '--error-unmatch', '--', binding['proofTestRemotePath']], cwd=candidate, capture_output=True)
                assert tracked.returncode == 1
                overlay.unlink()
        if scratch is not None:
            shutil.rmtree(scratch)
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save('hosted-proof-result.json', receipt)
    print(json.dumps({'passed': receipt['passed'], 'pr': pr, 'phase': receipt['phase']}))
sys.exit(0 if receipt['passed'] else 1)
