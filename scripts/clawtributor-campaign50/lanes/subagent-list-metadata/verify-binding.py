import hashlib,json,pathlib,subprocess,sys
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text()); mode=sys.argv[2]
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==manifest['source_base']
assert subprocess.check_output(['node','--version'],text=True).strip()=='v'+manifest['node']
assert subprocess.check_output(['pnpm','--version'],text=True).strip()=='12.3.4'
assert json.loads(pathlib.Path('package.json').read_text())['packageManager']==manifest['packageManager']
owner=manifest['owner']
expected=owner['baseline_sha256' if mode=='baseline' else 'candidate_sha256']
assert hashlib.sha256(pathlib.Path(owner['path']).read_bytes()).hexdigest()==expected
changed=subprocess.check_output(['git','diff','--no-ext-diff','--name-only','HEAD','--'],text=True).splitlines()
assert changed==([] if mode=='baseline' else [owner['path']]),changed
print('Pinned source, owner bytes, Node and package manager verified before target execution')
