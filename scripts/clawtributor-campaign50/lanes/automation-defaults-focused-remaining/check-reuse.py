import importlib.util
import json
import pathlib
import shutil
import tempfile

lane = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('reuse_reader', lane / 'validate-reuse.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.validate(lane)
results = []
for name, file, change in [
    ('original job relabeled green', 'reuse/run.json', lambda data: data.update(conclusion='success')),
    ('source SHA changed', 'reuse/source.json', lambda data: data.update(source='0' * 40)),
    ('artifact identity changed', 'reuse/artifacts.json', lambda data: data['artifacts'][0].update(id=0)),
    ('unit source receipt changed', 'reuse/hashes-unit-red.json', lambda data: data['sourceHashes'].update({'src/config/schema.hints.test.ts': '0' * 64})),
    ('unit source candidate changed', 'MANIFEST.json', lambda data: data['candidateHashes'].update({'src/config/schema.hints.test.ts': '0' * 64})),
]:
    with tempfile.TemporaryDirectory(prefix='config-reuse-reader-') as directory:
        copy = pathlib.Path(directory) / 'packet'
        shutil.copytree(lane, copy)
        target = copy / file
        data = json.loads(target.read_text())
        change(data)
        target.write_text(json.dumps(data))
        try:
            module.validate(copy)
        except AssertionError:
            results.append({'name': name, 'rejected': True})
        else:
            raise AssertionError(f'Accepted invalid reuse: {name}')
print(json.dumps({'scope': 'inert cached-data lineage controls; no target execution', 'positive': 1, 'negative': results}, indent=2))
