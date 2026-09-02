from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import sys
import tarfile

G = Path(__file__).resolve().parent
binding = json.loads((G / 'execution-binding.json').read_text())
receipts = [json.loads(line.split(' ', 1)[1]) for line in (G / 'remote.stdout').read_text().splitlines() if line.startswith('GATEWAY_QUOTE_PROOF_RECEIPT ')]
assert len(receipts) == 1
receipt = receipts[0]
assert receipt['head'] == binding['candidateHead']
if receipt.get('artifact') is None:
    assert receipt.get('passed') is False
    (G / 'local-proof-verdict.json').write_text(json.dumps({'proof': receipt, 'archiveAvailable': False}, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
    sys.exit(1)
archive = G / ('proof-success.tgz' if receipt.get('passed') else 'proof-failure.tgz')
assert archive.stat().st_size == receipt['artifactBytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == receipt['artifactSHA256']
allowed = {'proof-verdict.json', 'requested-binding.json', 'source-binding.json', 'source-after.json', 'proof.test.ts', 'test.stdout', 'test.stderr', 'vitest.json', 'behavior/verdict.json', 'behavior/report.md'}
out = G / 'extracted'
assert not out.exists()
os.umask(0o077)
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    assert len(members) <= len(allowed) and len({m.name for m in members}) == len(members)
    assert sum(m.size for m in members) <= 65 * 1024 * 1024
    for m in members:
        p = PurePosixPath(m.name)
        assert m.name in allowed and not p.is_absolute() and '..' not in p.parts and m.isfile()
    out.mkdir(mode=0o700)
    for m in members:
        dest = out / m.name
        dest.parent.mkdir(mode=0o700, exist_ok=True)
        with tar.extractfile(m) as f:
            dest.write_bytes(f.read())
proof = json.loads((out / 'proof-verdict.json').read_text())
assert proof['head'] == binding['candidateHead']
assert proof.get('passed') == receipt.get('passed')
if proof.get('passed'):
    before = json.loads((out / 'source-binding.json').read_text())
    after = json.loads((out / 'source-after.json').read_text())
    behavior = json.loads((out / 'behavior/verdict.json').read_text())
    vitest = json.loads((out / 'vitest.json').read_text())
    assert before['sourceHashes'] == after['sourceHashes'] == binding['candidateFileSHA256']
    for key in ['head', 'tree', 'index', 'proofTest', 'installedBaileys', 'installedLockSHA256']:
        assert before[key] == after[key]
    assert before['head'] == binding['candidateHead'] and before['tree'] == binding['candidateTree']
    assert before['hostedProvenance'] == binding['hostedProvenance']
    assert before['proofTest']['sha256'] == binding['proofTestSHA256'] == hashlib.sha256((out / 'proof.test.ts').read_bytes()).hexdigest()
    assert before['proofTest']['tracked'] is False
    assert before['command'] == proof['command']
    assert before['command'][:6] == [binding['nodeExecutable'], *binding['commandSuffix']]
    assert before['command'][6:8] == ['--reporter=default', '--reporter=json']
    assert before['command'][8].startswith('--outputFile=/tmp/openclaw-127959-quote-proof-') and before['command'][8].endswith('/vitest.json')
    assert before['hydrate'] is False and before['provider'] == 'github-actions' and before['executionEnvironment'] == 'github-hosted'
    assert set(before['envNames']) == {'PATH','HOME','CI','COREPACK_HOME','COREPACK_ENABLE_DOWNLOAD_PROMPT','OPENCLAW_QUOTE_PROOF_DIR','OPENCLAW_QUOTE_PROOF_BINDING','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','OPENCLAW_STATE_DIR'}
    assert before['installedBaileys'] == {'version': binding['baileys']['version'], 'hashes': {r['path']:r['sha256'] for r in binding['baileys']['inspectedFiles']}}
    assert proof['exitCode'] == 0 and proof['sourceUnchanged'] and proof['fullProofCompleted']
    assert behavior['schema'] == 'openclaw-pr-127959-gateway-quote-proof-v1'
    assert behavior['binding'] == before
    assert [c['name'] for c in behavior['cases']] == binding['expectedScenarioIds']
    assert behavior['status'] == 'pass' and behavior['expectedScenarios'] == behavior['executedScenarios'] == behavior['passedScenarios'] == 8
    assert behavior['setupError'] is None and behavior['cleanupErrors'] == []
    assert all(c['status'] == 'pass' and len(c['observations']) == 1 for c in behavior['cases'])
    assert vitest['success'] and vitest['numTotalTests'] == vitest['numPassedTests'] == 1
    assert vitest['numFailedTests'] == vitest['numPendingTests'] == vitest['numTodoTests'] == 0
    assert len(vitest['testResults']) == len(vitest['testResults'][0]['assertionResults']) == 1
    assert vitest['testResults'][0]['assertionResults'][0]['status'] == 'passed'
result = {'candidateHead': binding['candidateHead'], 'proof': proof, 'archiveSHA256': receipt['artifactSHA256'], 'archiveBytes': receipt['artifactBytes'], 'sourceFileCount': binding['sourceFileCount'], 'proofTestSHA256': binding['proofTestSHA256'], 'candidateExecution': 'GitHub-hosted runner; no injected repository secrets', 'limitations': ['Real Gateway send RPC and WhatsApp/Baileys encoding with mock socket acceptance.', 'No real WhatsApp service/client rendering, inbound network turn, or model-provider inference.']}
(G / 'local-proof-verdict.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))

sys.exit(0 if proof.get('passed') else 1)
