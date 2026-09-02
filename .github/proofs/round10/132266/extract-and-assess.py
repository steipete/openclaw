"""Read proof data only; never execute archive contents."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import sys
import tarfile

G = Path(__file__).resolve().parent
binding = json.loads((G / 'execution-binding.json').read_text())
def save(value):
    (G / 'local-proof-verdict.json').write_text(json.dumps(value, indent=2) + '\n')

remote = G / 'remote.stdout'
receipts = [json.loads(line.split(' ', 1)[1]) for line in remote.read_text().splitlines() if line.startswith('TOOL_METADATA_PROOF_RECEIPT ')] if remote.exists() else []
if len(receipts) != 1:
    save({'passed': False, 'head': binding['candidateHead'], 'archiveAvailable': False, 'reason': 'No unique terminal driver receipt; inspect retained transport/bootstrap stdout/stderr. This is not test GREEN.'})
    sys.exit(1)
receipt = receipts[0]
assert receipt['head'] == binding['candidateHead']
if receipt.get('artifact') is None:
    assert receipt.get('passed') is False
    save({'passed': False, 'proof': receipt, 'archiveAvailable': False})
    sys.exit(1)
archive = G / ('proof-success.tgz' if receipt.get('passed') else 'proof-failure.tgz')
assert receipt['artifact'] == binding['remoteArchive']
assert archive.stat().st_size == receipt['artifactBytes'] <= 65 * 1024 * 1024
assert hashlib.sha256(archive.read_bytes()).hexdigest() == receipt['artifactSHA256']
phases = ['build', 'unit-normalizer', 'unit-cache', 'unit-resolver', 'metadata', 'gateway']
allowed = {'proof-verdict.json', 'requested-binding.json', 'source-binding.json', 'source-after.json', 'runtime-build.json', 'runtime-after.json', 'proof.test.ts', 'metadata-after.mjs', 'metadata-verdict.json', 'behavior/verdict.json', 'behavior/report.md'}
allowed.update(f'{phase}{suffix}' for phase in phases for suffix in ['.stdout', '.stderr', '.json', '-result.json'])
allowed.update({'behavior/startup-timeline.jsonl', 'behavior/staged-before.json', 'behavior/staged-after.json', 'behavior/child-cleanup.json', 'behavior/gateway.stdout.log', 'behavior/gateway.stderr.log', 'behavior/README.txt'})
out = G / 'extracted'
assert not out.exists(), 'Do not overwrite earlier evidence'
os.umask(0o077)
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    assert len(members) <= len(allowed) and len({m.name for m in members}) == len(members)
    assert sum(m.size for m in members) <= 64 * 1024 * 1024
    for m in members:
        p = PurePosixPath(m.name)
        assert m.name in allowed and not p.is_absolute() and '..' not in p.parts and m.isfile()
        assert m.name != 'behavior/startup-timeline.jsonl' or m.size <= 4 * 1024 * 1024
    out.mkdir(mode=0o700)
    for m in members:
        dest = out / m.name
        dest.parent.mkdir(mode=0o700, exist_ok=True)
        with tar.extractfile(m) as stream:
            dest.write_bytes(stream.read())
proof = json.loads((out / 'proof-verdict.json').read_text())
assert proof['head'] == binding['candidateHead'] and proof['passed'] == receipt['passed']
if proof['passed']:
    before = json.loads((out / 'source-binding.json').read_text())
    after = json.loads((out / 'source-after.json').read_text())
    for key in ['head', 'tree', 'index', 'sourceHashes', 'installedLockSHA256']:
        assert before[key] == after[key]
    assert before['head'] == binding['candidateHead'] and before['tree'] == binding['candidateTree']
    assert before['sourceHashes'] == binding['candidateFileSHA256']
    assert before['hydrate'] is False and before['provider'] == 'github-actions' and before['executionEnvironment'] == 'github-hosted'
    assert before['hostedProvenance'] == binding['hostedProvenance']
    assert before['packageManager'] == binding['packageManager'] and before['nodeVersion'] == 'v24.19.0'
    assert before['proofTest'] == {'path': binding['proofTestRemotePath'], 'sha256': binding['proofTestSHA256'], 'tracked': False}
    assert before['metadataHarnessSHA256'] == binding['metadataHarnessSHA256']
    base_env = {'PATH', 'HOME', 'CI', 'COREPACK_HOME', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'OPENCLAW_STATE_DIR'}
    assert set(before['envNames']) == set(phases)
    for phase, names in before['envNames'].items():
        assert set(names) == base_env | ({'OPENCLAW_METADATA_PROOF_DIR', 'OPENCLAW_METADATA_PROOF_BINDING'} if phase == 'gateway' else {'OPENCLAW_BUILD_PRIVATE_QA'} if phase == 'build' else set())
    assert hashlib.sha256((out / 'proof.test.ts').read_bytes()).hexdigest() == binding['proofTestSHA256']
    assert hashlib.sha256((out / 'metadata-after.mjs').read_bytes()).hexdigest() == binding['metadataHarnessSHA256']
    assert [phase['name'] for phase in proof['phases']] == phases
    assert all(phase['exitCode'] == 0 and phase['signal'] is None and phase['errorCode'] is None for phase in proof['phases'])
    assert proof['sourceUnchanged'] and proof['proofOverlayRemoved'] and proof['runtimeHomesRemoved'] and proof['fullProofCompleted']
    assert proof['cleanupErrors'] == []
    assert proof['buildCompleted'] and proof['runtimeArtifactsUnchanged'] and proof['gatewayChildCleanupConfirmed']
    assert [phase['argv'] for phase in proof['phases']] == [command['argv'] for command in before['commands']]
    commands = {command['name']: command['argv'] for command in before['commands']}
    for suite in binding['unitSuites']:
        argv = commands[suite['phase']]
        assert argv[:6] == [binding['nodeExecutable'], 'scripts/run-vitest.mjs', 'run', suite['path'], '--reporter=default', '--reporter=json']
        assert len(argv) == 7 and argv[6].startswith('--outputFile=/tmp/openclaw-132266-after-proof-') and argv[6].endswith('/' + suite['phase'] + '.json')
    build_command = commands['build']
    assert len(build_command) == 5 and build_command[:2] == [binding['nodeExecutable'], '--import']
    assert build_command[2].endswith('/scripts/tsx.mjs') and build_command[3:] == ['scripts/build-all.mts', 'qaRuntime']
    for phase in proof['phases']:
        assert phase['executionTimeoutMs'] == (180000 if phase['name'] == 'gateway' else 1200000)
        assert phase['cleanupReserveMs'] == 60000 and phase['timedOut'] is False
    gateway_command = commands['gateway']
    assert len(gateway_command) == 4 and gateway_command[:2] == [binding['nodeExecutable'], '--import']
    assert gateway_command[2].endswith('/scripts/tsx.mjs')
    assert gateway_command[3].endswith('/' + binding['proofTestRemotePath'])
    assert gateway_command[2].removesuffix('/scripts/tsx.mjs') == gateway_command[3].removesuffix('/' + binding['proofTestRemotePath'])
    metadata_command = commands['metadata']
    assert len(metadata_command) == 6 and metadata_command[:2] == [binding['nodeExecutable'], '--import']
    assert metadata_command[2].endswith('/scripts/tsx.mjs') and metadata_command[3].startswith('/tmp/openclaw-132266-after-proof-') and metadata_command[3].endswith('/metadata-after.mjs')
    assert metadata_command[4] == 'candidate' and metadata_command[5].startswith('/tmp/openclaw-132266-after-proof-') and metadata_command[5].endswith('/runtime/metadata/workspace')
    for suite in binding['unitSuites']:
        report = json.loads((out / (suite['phase'] + '.json')).read_text())
        assert report['success'] and report['numTotalTests'] == report['numPassedTests'] == suite['expectedTests']
        assert report['numFailedTests'] == report['numPendingTests'] == report['numTodoTests'] == 0
        assert len(report['testResults']) == 1 and report['testResults'][0]['name'].endswith('/' + suite['path'])
        assertions = report['testResults'][0]['assertionResults']
        assert len(assertions) == suite['expectedTests'] and all(a['status'] == 'passed' for a in assertions)
    behavior = json.loads((out / 'behavior/verdict.json').read_text())
    assert behavior['binding'] == before
    assert behavior['schema'] == 'openclaw-pr-132266-gateway-progress-proof-v2'
    assert behavior['runtime'] == 'built-child-gateway'
    build = json.loads((out / 'runtime-build.json').read_text())
    runtime_after = json.loads((out / 'runtime-after.json').read_text())
    assert runtime_after == build
    assert build['head'] == binding['candidateHead'] and build['tree'] == binding['candidateTree']
    assert build['profile'] == 'qaRuntime' and build['privateQa'] is True
    assert all(row['head'] == binding['candidateHead'] for row in build['stamps'].values())
    for name in ['dist/index.js', 'dist/extensions/qa-channel/index.js', 'dist/extensions/openai/index.js', 'dist/plugin-sdk/qa-channel-protocol.js']:
        assert len(build['files'][name]['sha256']) == 64
    assert behavior['childRuntime']['buildOutputSHA256'] == hashlib.sha256((out / 'runtime-build.json').read_bytes()).hexdigest()
    candidate_root = gateway_command[3].removesuffix('/' + binding['proofTestRemotePath'])
    assert behavior['childRuntime']['argv'][1:4] == [candidate_root + '/dist/index.js', 'gateway', 'run']
    assert behavior['childRuntime']['executable'] == binding['nodeExecutable']
    assert behavior['childCleanup']['confirmed'] is True and behavior['childCleanup']['interrupted'] is False
    assert behavior['childCleanup']['result'] == {'process': 'confirmed-stopped', 'errors': []}
    cleanup = json.loads((out / 'behavior/child-cleanup.json').read_text())
    assert cleanup['phase'] == 'finished' and cleanup['confirmed'] is True and cleanup['interrupted'] is False
    assert cleanup['result'] == behavior['childCleanup']['result'] and cleanup['errors'] == []
    staged = json.loads((out / 'behavior/staged-before.json').read_text())
    assert staged == json.loads((out / 'behavior/staged-after.json').read_text()) == behavior['stagedBefore'] == behavior['stagedAfter']
    assert staged['runtimeRoot'].startswith(candidate_root + '/.artifacts/qa-runtime/openclaw-qa-suite-')
    assert staged['bundledDir'] == staged['runtimeRoot'] + '/dist/extensions'
    assert set(staged['plugins']) == {'qa-channel', 'openai'}
    for plugin_id, plugin in staged['plugins'].items():
        assert plugin['directory'] == staged['bundledDir'] + '/' + plugin_id
        assert 'index.js' in plugin['files']
        for name, fact in plugin['files'].items():
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            assert not name.endswith(('.ts', '.tsx', '.mts', '.cts')) or name.endswith(('.d.ts', '.d.mts', '.d.cts'))
            source = f'extensions/{plugin_id}/{name}' if name == 'openclaw.plugin.json' else f'dist/extensions/{plugin_id}/{name}'
            expected = binding['candidateFileSHA256'][source] if name == 'openclaw.plugin.json' else build['files'][source]['sha256']
            assert fact['sha256'] == expected
    for name in ['gateway.stdout.log', 'gateway.stderr.log', 'README.txt']:
        assert (out / 'behavior' / name).is_file()
    assert behavior['fixture']['observerReady'] is True and behavior['fixture']['eventOverflow'] is False
    assert behavior['status'] == 'pass' and behavior['expectedScenarios'] == behavior['executedScenarios'] == behavior['passedScenarios'] == 5
    assert [row['id'] for row in behavior['results']] == binding['expectedScenarioIds']
    assert all(row['status'] == 'pass' for row in behavior['results'])
    assert behavior['providerErrors'] == behavior['invariantErrors'] == behavior['cleanupErrors'] == []
    assert proof['metadataScenariosPassed'] == 6
    assert before['metadataScenarioIds'] == binding['metadataScenarioIds']
    assert behavior['ownerBoundaryEvidence'] == {
        'kind': 'same-head-metadata-phase',
        'head': binding['candidateHead'],
        'harnessSHA256': binding['metadataHarnessSHA256'],
        'verdictSHA256': hashlib.sha256((out / 'metadata-verdict.json').read_bytes()).hexdigest(),
        'scenarios': binding['metadataScenarioIds'],
    }
    assert behavior['fixture']['factories'] > 0
    assert len(behavior['providerRequests']) == 10 and len(behavior['fixture']['executions']) == 5
    metadata = json.loads((out / 'metadata-verdict.json').read_text())
    assert metadata['mode'] == 'candidate' and metadata['factories'] == 3 and metadata['executions'] == 6
    assert [row['label'] for row in metadata['rows']] == binding['metadataScenarioIds']
    for row in metadata['rows']:
        hidden = row['label'] not in ['cache-hit-visible', 'visible']
        assert row['marker'] == hidden and row['lifecycleEvents'] == 3 and row['finalReplies'] == 1
        assert row['progressCallbacks'] == (0 if hidden else 2) and row['itemCallbacks'] == (0 if hidden else 1)
save({'passed': proof['passed'], 'candidateHead': binding['candidateHead'], 'proof': proof, 'archiveSHA256': receipt['artifactSHA256'], 'archiveBytes': receipt['artifactBytes'], 'sourceFileCount': binding['sourceFileCount'], 'candidateExecution': 'GitHub-hosted runner; no injected repository secrets', 'limitations': ['Synthetic QA-channel plus mock OpenAI HTTP, not Telegram or public model service.', 'The separate same-head metadata lane proves descriptor cache and normalizer invariants; built child Gateway proves the five external flows.', 'No Codex process executed.']})
print(json.dumps({'passed': proof['passed'], 'head': binding['candidateHead']}))
sys.exit(0 if proof['passed'] else 1)
