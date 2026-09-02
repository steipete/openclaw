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
phases = ['unit-normalizer', 'unit-cache', 'unit-resolver', 'gateway', 'metadata']
allowed = {'proof-verdict.json', 'requested-binding.json', 'source-binding.json', 'source-after.json', 'proof.test.ts', 'metadata-after.mjs', 'metadata-verdict.json', 'behavior/verdict.json', 'behavior/report.md'}
allowed.update(f'{phase}{suffix}' for phase in phases for suffix in ['.stdout', '.stderr', '.json', '-result.json'])
allowed.add('behavior/startup-timeline.jsonl')
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
        assert set(names) == base_env | ({'OPENCLAW_METADATA_PROOF_DIR', 'OPENCLAW_METADATA_PROOF_BINDING'} if phase == 'gateway' else set())
    assert hashlib.sha256((out / 'proof.test.ts').read_bytes()).hexdigest() == binding['proofTestSHA256']
    assert hashlib.sha256((out / 'metadata-after.mjs').read_bytes()).hexdigest() == binding['metadataHarnessSHA256']
    assert [phase['name'] for phase in proof['phases']] == phases
    assert all(phase['exitCode'] == 0 and phase['signal'] is None and phase['errorCode'] is None for phase in proof['phases'])
    assert proof['sourceUnchanged'] and proof['proofOverlayRemoved'] and proof['runtimeHomesRemoved'] and proof['fullProofCompleted']
    assert proof['cleanupErrors'] == []
    assert [phase['argv'] for phase in proof['phases']] == [command['argv'] for command in before['commands']]
    commands = {command['name']: command['argv'] for command in before['commands']}
    for suite in binding['unitSuites']:
        argv = commands[suite['phase']]
        assert argv[:6] == [binding['nodeExecutable'], 'scripts/run-vitest.mjs', 'run', suite['path'], '--reporter=default', '--reporter=json']
        assert len(argv) == 7 and argv[6].startswith('--outputFile=/tmp/openclaw-132266-after-proof-') and argv[6].endswith('/' + suite['phase'] + '.json')
    assert commands['gateway'][:8] == [binding['nodeExecutable'], 'scripts/run-vitest.mjs', 'run', '--config', 'test/vitest/vitest.extension-qa.config.ts', binding['proofTestRemotePath'], '--reporter=default', '--reporter=json']
    assert len(commands['gateway']) == 9 and commands['gateway'][8].startswith('--outputFile=/tmp/openclaw-132266-after-proof-') and commands['gateway'][8].endswith('/gateway.json')
    metadata_command = commands['metadata']
    assert len(metadata_command) == 6 and metadata_command[:2] == [binding['nodeExecutable'], '--import']
    assert metadata_command[2].endswith('/scripts/tsx.mjs') and metadata_command[3].startswith('/tmp/openclaw-132266-after-proof-') and metadata_command[3].endswith('/metadata-after.mjs')
    assert metadata_command[4] == 'candidate' and metadata_command[5].startswith('/tmp/openclaw-132266-after-proof-') and metadata_command[5].endswith('/runtime/metadata/workspace')
    for suite in [*binding['unitSuites'], {'phase': 'gateway', 'path': binding['proofTestRemotePath'], 'expectedTests': 1}]:
        report = json.loads((out / (suite['phase'] + '.json')).read_text())
        assert report['success'] and report['numTotalTests'] == report['numPassedTests'] == suite['expectedTests']
        assert report['numFailedTests'] == report['numPendingTests'] == report['numTodoTests'] == 0
        assert len(report['testResults']) == 1 and report['testResults'][0]['name'].endswith('/' + suite['path'])
        assertions = report['testResults'][0]['assertionResults']
        assert len(assertions) == suite['expectedTests'] and all(a['status'] == 'passed' for a in assertions)
    behavior = json.loads((out / 'behavior/verdict.json').read_text())
    assert behavior['binding'] == before
    assert behavior['schema'] == 'openclaw-pr-132266-gateway-progress-proof-v1'
    assert behavior['status'] == 'pass' and behavior['expectedScenarios'] == behavior['executedScenarios'] == behavior['passedScenarios'] == 5
    assert [row['id'] for row in behavior['results']] == binding['expectedScenarioIds']
    assert all(row['status'] == 'pass' for row in behavior['results'])
    assert behavior['providerErrors'] == behavior['invariantErrors'] == behavior['cleanupErrors'] == []
    assert any(row['factoryAfter'] > row['factoryBefore'] for row in behavior['resolverRows'])
    assert any(row['factoryAfter'] == row['factoryBefore'] for row in behavior['resolverRows'])
    assert behavior['normalizationRows'] and all(row['sourceHidden'] == row['targetHidden'] for row in behavior['normalizationRows'])
    assert len(behavior['providerRequests']) == 10 and len(behavior['fixture']['executions']) == 5
    metadata = json.loads((out / 'metadata-verdict.json').read_text())
    assert metadata['mode'] == 'candidate' and metadata['factories'] == 3 and metadata['executions'] == 6
    assert [row['label'] for row in metadata['rows']] == binding['metadataScenarioIds']
    for row in metadata['rows']:
        hidden = row['label'] not in ['cache-hit-visible', 'visible']
        assert row['marker'] == hidden and row['lifecycleEvents'] == 3 and row['finalReplies'] == 1
        assert row['progressCallbacks'] == (0 if hidden else 2) and row['itemCallbacks'] == (0 if hidden else 1)
save({'passed': proof['passed'], 'candidateHead': binding['candidateHead'], 'proof': proof, 'archiveSHA256': receipt['artifactSHA256'], 'archiveBytes': receipt['artifactBytes'], 'sourceFileCount': binding['sourceFileCount'], 'candidateExecution': 'GitHub-hosted runner; no injected repository secrets', 'limitations': ['Synthetic QA-channel plus mock OpenAI HTTP, not Telegram or public model service.', 'Native strict-normalizer metadata lane is a production channel-handler projection, not native OpenAI HTTP.', 'No Codex process executed.']})
print(json.dumps({'passed': proof['passed'], 'head': binding['candidateHead']}))
sys.exit(0 if proof['passed'] else 1)
