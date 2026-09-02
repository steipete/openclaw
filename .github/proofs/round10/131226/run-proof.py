"""Fixed secretless hosted before/after proof. Do not run on a maintainer machine."""
from pathlib import Path
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback

os.umask(0o077)
assets = Path(__file__).resolve().parent
checkout, evidence = map(lambda value: Path(value).resolve(), sys.argv[1:])
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
binding = json.loads((assets / 'execution-binding.json').read_text())
receipt = {'passed': False, 'phase': 'setup', 'baselineRed': False, 'candidateStarted': False,
           'commands': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': [],
           'proofScope': 'TTS/WAV media after provider HTTP 503'}
scratch = None
original_owner = None
installed_lock = None
node = None
active_phase = None
proof_path = checkout / binding['proofPath']
owner_path = checkout / binding['ownerPath']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def digest(file):
    return sha(Path(file).read_bytes())

def save(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')

def git(*args, cwd=checkout):
    return subprocess.check_output(['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=cwd).strip()

def source_snapshot(mode):
    assert git('rev-parse', 'HEAD').decode() == binding['baseHead']
    assert git('rev-parse', 'HEAD^{tree}').decode() == binding['baseTree']
    assert git('remote', 'get-url', 'origin').decode() == 'https://github.com/openclaw/openclaw'
    assert not git('diff', '--cached', '--name-only')
    changed = git('diff', '--no-ext-diff', '--name-only').decode().splitlines()
    assert changed == ([] if mode == 'baseline' else [binding['ownerPath']]), changed
    hashes = dict(binding['sourceHashes'])
    if mode == 'candidate':
        hashes[binding['ownerPath']] = binding['candidateOwnerSHA256']
    for name, expected in hashes.items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(checkout / name) == expected, name
    index = sha(subprocess.check_output(['/usr/bin/git', '-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z'], cwd=checkout))
    lock = checkout / 'node_modules/.pnpm/lock.yaml'
    current_lock = digest(lock) if lock.exists() else None
    if installed_lock is not None:
        assert current_lock == installed_lock
    credentials = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp', '(extraheader|credential)'], cwd=checkout, capture_output=True)
    assert credentials.returncode == 1 and not credentials.stdout
    return {'head': binding['baseHead'], 'tree': binding['baseTree'], 'mode': mode,
            'sourceIdentity': binding['baseHead'] + ('' if mode == 'baseline' else '+owner-sha256:' + binding['candidateOwnerSHA256']),
            'sourceHashes': hashes, 'indexSHA256': index, 'installedLockSHA256': current_lock}

def run(name, argv, cwd, env, directory, timeout):
    receipt['phase'] = name
    print('PROOF_PHASE:' + name, flush=True)
    result = {'name': name, 'argv': argv, 'exitCode': None, 'timedOut': False,
              'executionTimeoutSeconds': timeout, 'cleanupReserveSeconds': 60}
    is_gateway = name in ('baseline-gateway', 'candidate-gateway')
    completed = False
    started = time.monotonic()
    try:
        with (directory / (name + '.stdout')).open('xb') as out, (directory / (name + '.stderr')).open('xb') as err:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
            try:
                result['exitCode'] = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                result['timedOut'] = True
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    result['exitCode'] = child.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    result['exitCode'] = child.wait(timeout=10)
        assert not result['timedOut'], name + ' exceeded execution deadline'
        assert result['exitCode'] == 0, name + ' failed'
        completed = True
    finally:
        # wait() observes only the command leader, including after a group signal.
        # Failed non-Gateway phases have no descendant-closure owner; retain their
        # private runtime instead of treating leader exit as confirmed shutdown.
        result['processGroupClosure'] = 'gateway-owner-receipt-required' if is_gateway else 'not-verified'
        if not is_gateway and not completed:
            receipt['unconfirmedCommandGroups'].append(name)
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(directory / (name + '-result.json'), result)

def inventory(mode, phase_dir, label):
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
            assert file.is_file(), name
            files[name] = {'sha256': digest(file), 'bytes': file.stat().st_size}
    for name in roots:
        visit(name)
    data = {'head': binding['baseHead'], 'tree': binding['baseTree'], 'sourceIdentity': source_snapshot(mode)['sourceIdentity'],
            'profile': 'qaRuntime', 'privateQa': True, 'roots': roots, 'files': files}
    # Failure evidence precedes containment/entry guards, including legitimate root self-links.
    save(phase_dir / label, data)
    for name, resolved in links:
        assert resolved == checkout or checkout in resolved.parents, (name, str(resolved))
    for name in ['dist/index.js', 'dist/extensions/qa-channel/index.js', 'dist/extensions/openai/index.js', 'dist/plugin-sdk/qa-runtime.js']:
        assert files.get(name, {}).get('sha256'), 'Missing built entry: ' + name
    for name in ['dist/.buildstamp', 'dist/.runtime-postbuildstamp']:
        assert json.loads((checkout / name).read_text())['head'] == binding['baseHead']
    return data

def runtime_env(label):
    home = scratch / label
    home.mkdir(mode=0o700)
    env = {'PATH': environment_path, 'HOME': str(home), 'CI': '1',
           'COREPACK_HOME': str(scratch / 'corepack'), 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'}
    for key, name in [('TMPDIR', 'tmp'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                      ('XDG_DATA_HOME', 'data'), ('OPENCLAW_STATE_DIR', 'state')]:
        directory = home / name
        directory.mkdir(mode=0o700)
        env[key] = str(directory)
    return env

def prove(mode):
    global active_phase
    active_phase = mode
    phase_dir = evidence / mode
    phase_dir.mkdir(mode=0o700)
    before = source_snapshot(mode)
    save(phase_dir / 'source-before.json', before)
    build_env = runtime_env(mode + '-build')
    build_env.update(OPENCLAW_BUILD_PRIVATE_QA='1', OPENCLAW_BUILD_CACHE='0')
    run(mode + '-build', [node, '--import', str(checkout / 'scripts/tsx.mjs'), 'scripts/build-all.mts', 'qaRuntime'], checkout, build_env, phase_dir, 1200)
    assert source_snapshot(mode) == before
    built = inventory(mode, phase_dir, 'runtime-build.json')
    assert not proof_path.exists() and not proof_path.is_symlink()
    assert subprocess.run(['/usr/bin/git', 'ls-files', '--error-unmatch', '--', binding['proofPath']], cwd=checkout, capture_output=True).returncode == 1
    assert proof_path.parent.resolve() == checkout / 'extensions/qa-lab/src'
    proof_path.write_bytes((assets / 'gateway-proof.mjs').read_bytes())
    env = runtime_env(mode + '-gateway')
    env.update(OPENCLAW_ENABLE_PRIVATE_QA_CLI='1', OPENCLAW_DISABLE_BUNDLED_PLUGINS='0', OPENCLAW_SKIP_CRON='1',
               OPENCLAW_GATEWAY_STARTUP_TRACE='1', OPENCLAW_DIAGNOSTICS='timeline',
               OPENCLAW_DIAGNOSTICS_TIMELINE_PATH=str(phase_dir / 'startup-timeline.jsonl'),
               OPENCLAW_MEDIA_PROOF_DIR=str(phase_dir), OPENCLAW_MEDIA_PROOF_BINDING=str(phase_dir / 'execution-binding.json'))
    phase_binding = {**binding, **before, 'baseHead': binding['baseHead'], 'sourceHashes': before['sourceHashes'],
                     'hostedProvenance': provenance, 'nodeExecutable': node, 'envNames': sorted(env)}
    save(phase_dir / 'execution-binding.json', phase_binding)
    try:
        run(mode + '-gateway', [node, '--import', str(checkout / 'scripts/tsx.mjs'), str(proof_path)], checkout, env, phase_dir, 180)
    finally:
        assert digest(proof_path) == binding['proofSHA256']
        proof_path.unlink()
        after = source_snapshot(mode)
        save(phase_dir / 'source-after.json', after)
        assert after == before
        assert inventory(mode, phase_dir, 'runtime-after.json') == built, 'Built runtime changed during proof'
    verdict = json.loads((phase_dir / 'gateway-verdict.json').read_text())
    assert verdict['schema'] == 'openclaw-131226-media-proof-v1'
    assert verdict['binding'] == phase_binding
    assert verdict['runtime'] == 'built-child-gateway'
    assert verdict['completed'] is True and not verdict['errors'] and not verdict['cleanupErrors']
    cleanup = verdict['childCleanup']
    assert cleanup['confirmed'] is True and cleanup['interrupted'] is False
    assert cleanup['result'] == {'process': 'confirmed-stopped', 'errors': []}
    assert verdict['stagedBefore'] == verdict['stagedAfter']
    assert verdict['childRuntime']['buildInventorySHA256'] == digest(phase_dir / 'runtime-build.json')
    facts = verdict['observation']
    assert facts['scenario'] == 'tts-wav-then-provider-503' and facts['prerequisitesPassed'] is True
    assert facts['ttsCalls'] == 1 and facts['failedFollowupReceivedToolOutput'] is True and facts['terminalState'] == 'error'
    completion = facts['chronology']['completedTool']
    assert completion['evidenceSource'] == 'provider-consumed-successful-tts-result'
    assert completion['transport'] == 'http' and completion['requestKind'] == 'tool-continuation'
    assert completion['plannedCursor'] == 1 and completion['outputCursor'] == 2
    assert completion['wireType'] == 'function_call_output'
    assert completion['returnedText'] == '(spoken) Runtime parity voice fixture.'
    assert completion['outputSHA256'] == hashlib.sha256(completion['returnedText'].encode()).hexdigest()
    assert completion['explicitErrorFlag'] is False
    assert completion['userIndex'] < completion['callIndex'] < completion['outputIndex']
    assert completion['toolCallId'] == facts['chronology']['plannedTool']['callId']
    assert completion['toolCallId'] == facts['chronology']['failedFollowup']['toolOutputCallId']
    barrier = facts['persistenceBarrier']
    assert barrier['subscriptionAcknowledged'] is True and barrier['sessionKey'] == 'agent:qa:tool-media-terminal'
    assert barrier['reason'] == 'chat.run.settled' and barrier['hasActiveRun'] is False
    assert barrier['lastRunId'] == barrier['admittedRunId'] and barrier['deadlineMs'] == 90_000
    active_phase = None
    return verdict

try:
    assert platform.system() == 'Linux'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/round10-media-terminal-proof'
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'candidate'
    proof_checkout = assets.parents[3]
    assert git('rev-parse', 'HEAD', cwd=proof_checkout).decode() == os.environ['GITHUB_SHA']
    manifest = json.loads((assets / 'manifest.json').read_text())
    for name, expected in manifest['sha256'].items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert digest(proof_checkout / name) == expected, name
    assert binding['baseHead'] == 'af531525c46444521986002d64b888ee5ed097cb'
    assert digest(assets / 'gateway-proof.mjs') == binding['proofSHA256']
    assert digest(assets / 'candidate-owner.ts.txt') == binding['candidateOwnerSHA256']
    assert binding['productionNumstat'] == {'added': 4, 'deleted': 4, 'net': 0}
    source_snapshot('baseline')
    assert not (checkout / 'node_modules').exists()
    node = str(Path(shutil.which('node')).resolve())
    assert subprocess.check_output([node, '--version'], text=True).strip() == 'v24.19.0'
    corepack = Path(node).parent / 'corepack'
    assert corepack.is_file()
    scratch = Path(tempfile.mkdtemp(prefix='p131-', dir='/tmp')).resolve()
    for name in ['corepack', 'bin']:
        (scratch / name).mkdir(mode=0o700)
    environment_path = str(scratch / 'bin') + ':' + str(Path(node).parent) + ':/usr/bin:/bin'
    bootstrap = runtime_env('bootstrap')
    provenance = {key: os.environ[key] for key in ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
                  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']}
    save(evidence / 'hosted-source.json', {'binding': binding, 'nodeExecutable': node, 'hostedProvenance': provenance,
         'manifestSHA256': digest(assets / 'manifest.json'), 'bootstrapEnvNames': sorted(bootstrap)})
    assert json.loads((checkout / 'package.json').read_text())['packageManager'] == binding['packageManager']
    run('corepack-enable', [str(corepack), 'enable', '--install-directory', str(scratch / 'bin')], scratch, bootstrap, evidence, 300)
    run('corepack-prepare', [str(corepack), 'prepare', binding['packageManager'], '--activate'], scratch, bootstrap, evidence, 300)
    pnpm = str(scratch / 'bin/pnpm')
    run('pnpm-version', [pnpm, '--version'], scratch, bootstrap, evidence, 300)
    assert (evidence / 'pnpm-version.stdout').read_text().strip() == '12.1.0'
    run('install', [pnpm, 'install', '--frozen-lockfile'], checkout, bootstrap, evidence, 1200)
    installed_lock = digest(checkout / 'node_modules/.pnpm/lock.yaml')
    original_owner = owner_path.read_bytes()
    baseline = prove('baseline')
    # RED means the actual generated audio disappeared, not merely an error flag
    # or an infrastructure/assertion failure. A preserved baseline stops this lane.
    assert baseline['observation']['persistedAudioArtifacts'] == 0, 'Premise not reproduced: baseline history retained media; candidate was not run'
    receipt['baselineRed'] = True
    save(evidence / 'baseline-red.json', {'expectedFailure': 'generated WAV absent from actual terminal WebChat history',
         'verdictSHA256': digest(evidence / 'baseline/gateway-verdict.json'), 'prerequisitesPassed': True})
    assert digest(owner_path) == binding['sourceHashes'][binding['ownerPath']]
    owner_path.write_bytes((assets / 'candidate-owner.ts.txt').read_bytes())
    receipt['candidateStarted'] = True
    candidate = prove('candidate')
    facts = candidate['observation']
    assert facts['persistedAudioArtifacts'] == 1
    assert facts['mediaReplies'] > 0 and facts['errorMarkedMediaReplies'] == 0
    assert candidate['downloaded'] == binding['expectedDownloaded']
    receipt.update(passed=True, phase='complete', candidateIdentity=candidate['binding']['sourceIdentity'])
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        assert not receipt['unconfirmedCommandGroups'], 'Non-Gateway process-group closure unconfirmed; private scratch/runtime retained until ephemeral runner teardown'
        if proof_path.exists():
            assert not proof_path.is_symlink() and digest(proof_path) == binding['proofSHA256']
            proof_path.unlink()
        safe_cleanup = True
        if active_phase is not None:
            cleanup_path = evidence / active_phase / 'child-cleanup.json'
            # Build failures start no Gateway; missing Gateway receipt after an
            # attempted run means preserve runtime and let the ephemeral job end.
            started_gateway = any(row['name'] == active_phase + '-gateway' for row in receipt['commands'])
            if started_gateway:
                cleanup = json.loads(cleanup_path.read_text())
                safe_cleanup = cleanup['confirmed'] is True and not cleanup['errors']
        assert safe_cleanup, 'Child cleanup unconfirmed; runtime kept until ephemeral runner teardown'
        if original_owner is not None and receipt['candidateStarted']:
            assert digest(owner_path) == binding['candidateOwnerSHA256']
            owner_path.write_bytes(original_owner)
        if original_owner is not None:
            save(evidence / 'source-restored.json', source_snapshot('baseline'))
        if scratch is not None:
            shutil.rmtree(scratch)
        receipt['ownedScratchRemoved'] = True
    except Exception as error:
        receipt['ownedScratchRemoved'] = False
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    # Only public synthetic receipts, sanitized child logs, and command logs live
    # in evidence. Runtime HOME/config/auth/state are outside the upload root.
    try:
        files = [file for file in evidence.rglob('*') if file.is_file()]
        assert all(not file.is_symlink() for file in files)
        assert sum(file.stat().st_size for file in files) <= 64 * 1024 * 1024
        save(evidence / 'artifact-manifest.json', {str(file.relative_to(evidence)): digest(file) for file in files})
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'baselineRed', 'candidateStarted']}))
sys.exit(0 if receipt['passed'] else 1)
