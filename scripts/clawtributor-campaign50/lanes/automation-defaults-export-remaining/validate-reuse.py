import hashlib
import json
import pathlib
import sys


def validate(lane):
    reuse = lane / 'reuse'
    read = lambda name: (reuse / name).read_bytes()
    obj = lambda name: json.loads(read(name))
    current = json.loads((lane / 'MANIFEST.json').read_bytes())
    lineage = current['reusedUnitBaseline']
    carrier = lineage['carriers']['reuse/unit-red.log.txt']
    assert carrier['originalArtifactPath'] == 'unit-red.log' and carrier['byteIdentical'] is True
    assert hashlib.sha256(read('unit-red.log.txt')).hexdigest() == carrier['sha256']
    original = obj('original-manifest.json')
    assert hashlib.sha256(read('original-manifest.json')).hexdigest() == lineage['manifest']
    assert lineage['manifest'] == '04081fa46fe0258408a9d5ecb1a3ab9e9d622e81ca3423d8d890a84ca955f001'
    assert original['source'] == current['source'] == '74fd11e05f2d5730dc03a67e27cc2d227ca5b339'
    assert original['sourceHashes'] == current['sourceHashes']
    assert original['candidateHashes'] == current['candidateHashes']
    assert hashlib.sha256((lane / 'regression.patch').read_bytes()).hexdigest() == original['files']['regression.patch']
    assert hashlib.sha256((lane / 'production.patch').read_bytes()).hexdigest() == original['files']['production.patch']
    run = obj('run.json')
    assert run['databaseId'] == lineage['run'] == 34187057922
    assert run['headSha'] == lineage['harness'] == 'f2da1abb5f41eb119544abe6a82f9857f74176ff'
    assert run['attempt'] == 1 and run['status'] == 'completed' and run['conclusion'] == 'failure'
    jobs = [job for job in run['jobs'] if job['databaseId'] == lineage['job']]
    assert len(jobs) == 1 and jobs[0]['databaseId'] == 101937436657
    assert jobs[0]['status'] == 'completed' and jobs[0]['conclusion'] == lineage['jobConclusion'] == 'failure'
    artifacts = obj('artifacts.json')['artifacts']
    assert len(artifacts) == 1
    artifact = artifacts[0]
    assert artifact['id'] == lineage['artifactId'] == 10040886450
    assert artifact['name'] == lineage['artifactName'] == 'campaign50-automation-defaults-141548-1'
    assert artifact['digest'] == lineage['apiZipDigest'] == 'sha256:dc8dbb68e42a39d12f55d8c1ae937db93ebbd30600d4003500cde5f90ed3d8bd'
    assert artifact['expired'] is False
    downloads = obj('downloads.json')
    assert len(downloads) == 1 and downloads[0]['artifactId'] == artifact['id']
    assert downloads[0]['name'] == artifact['name'] and downloads[0]['apiZipDigest'] == artifact['digest']
    assert downloads[0]['downloadedOnce'] is True
    source = obj('source.json')
    assert source['source'] == current['source']
    assert source['node'] == current['node'] == '24.20.0'
    assert source['packageManager'] == current['packageManager']
    assert source['lane'] == 'automation-defaults-141548' and source['mode'] == 'green'
    for phase in ['before', 'unit-red']:
        receipt = obj(f'hashes-{phase}.json')
        expected = dict(original['sourceHashes'])
        if phase == 'unit-red':
            expected['src/config/schema.hints.test.ts'] = original['candidateHashes']['src/config/schema.hints.test.ts']
        assert receipt['phase'] == phase and receipt['source'] == current['source']
        assert receipt['manifestSha256'] == lineage['manifest']
        assert receipt['sourceHashes'] == expected and receipt['packetHashes'] == original['files']
    normalize = lambda text: '\n'.join(line for line in text.splitlines() if not line.startswith('index '))
    assert normalize(read('final-working-tree.patch').decode()) == normalize((lane / 'regression.patch').read_text())
    assert read('unit-red-exit.txt').strip() == b'1'
    assert read('exit-code.txt').strip() == b'1'
    assert read('phase.txt').strip() == b'unit-regression-red'
    return {'reusedRun': lineage['run'], 'reusedJob': lineage['job'], 'originalJobConclusion': 'failure', 'source': current['source'], 'originalManifest': lineage['manifest'], 'unitOverlayHash': original['candidateHashes']['src/config/schema.hints.test.ts'], 'bindingAccepted': True, 'remaining': 'unit-green/browser/changed gate; separate strict unit reader must accept reused raw report'}


if __name__ == '__main__':
    print(json.dumps(validate(pathlib.Path(sys.argv[1])), indent=2))
