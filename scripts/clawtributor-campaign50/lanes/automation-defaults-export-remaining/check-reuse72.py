import json
import pathlib
import shutil
import subprocess
import tempfile

lane = pathlib.Path(__file__).parent
subprocess.run(['node', str(lane / 'validate-reuse72.mjs'), str(lane)], check=True, stdout=subprocess.DEVNULL)
results = []
for name, file, change in [
    ('failed run relabeled green', 'reuse-72/run.json', lambda data: data.update(conclusion='success')),
    ('passed command status changed', 'reuse-72/remaining-checks.json', lambda data: data['results'][0].update(status=1)),
    ('unjoined work hidden', 'reuse-72/remaining-checks.json', lambda data: data['error'].update(unjoinedWork=True)),
    ('EOF missing', 'reuse-72/remaining-checks.json', lambda data: data['results'][1].update(stdoutEnded=False)),
    ('failed audit relabeled green', 'reuse-72/remaining-checks.json', lambda data: data['results'][3].update(status=0, exitCode=0)),
    ('passed command omitted', 'reuse-72/remaining-checks.json', lambda data: data['results'].pop(0)),
]:
    with tempfile.TemporaryDirectory(prefix='config-static-reuse-') as directory:
        copy = pathlib.Path(directory) / 'packet'
        shutil.copytree(lane, copy)
        target = copy / file
        data = json.loads(target.read_text())
        change(data)
        target.write_text(json.dumps(data))
        result = subprocess.run(['node', str(copy / 'validate-reuse72.mjs'), str(copy)], capture_output=True)
        assert result.returncode != 0 and b'AssertionError' in result.stderr, name
        results.append({'name': name, 'rejected': True})
with tempfile.TemporaryDirectory(prefix='config-type-export-') as directory:
    copy = pathlib.Path(directory) / 'packet'
    shutil.copytree(lane, copy)
    target = copy / 'types.ts'
    target.write_text(target.read_text().replace('ready: boolean;', 'ready: false;'))
    result = subprocess.run(['node', str(copy / 'validate-reuse72.mjs'), str(copy)], capture_output=True)
    assert result.returncode != 0 and b'AssertionError' in result.stderr
    results.append({'name': 'type body changed', 'rejected': True})
print(json.dumps({'scope': 'cached-data and static source-shape controls only', 'positive': 1, 'negative': results}, indent=2))
