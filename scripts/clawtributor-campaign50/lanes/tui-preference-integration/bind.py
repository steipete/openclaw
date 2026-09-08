"""Hash/Git state binding only; target source is never imported."""
from pathlib import Path
import hashlib,json,subprocess,sys
target,lane,evidence=(Path(p).resolve() for p in sys.argv[1:4]);phase=sys.argv[4]
m=json.loads((lane/'MANIFEST.json').read_text())
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*a):return subprocess.check_output(['git','-C',str(target),*a]).decode()
assert phase in {'initial','patched','final'}
assert git('rev-parse','HEAD').strip()==m['source']
for p,v in m['artifacts'].items():assert h(lane/p)==v,p
original=json.loads((lane/'ORIGINAL-NODE-GROUPS.json').read_text())
selected=json.loads((lane/'SELECTED-NODE-GROUPS.json').read_text())
assert selected==[{**original[1],'includePatterns':['ui/src/app/settings.preferences.node.test.ts']}]
cases=json.loads((lane/'ORIGINAL-PREFERENCE-CASES.json').read_text())
assert len(cases)==28 and len(set(cases))==28
expected=dict(m['sourceHashes'])
if phase=='initial':assert not git('status','--porcelain').strip()
else:
 expected.update(m['afterHashes'])
 assert sorted(git('diff','--name-only').splitlines())==sorted(m['afterHashes'])
 assert not git('diff','--cached','--name-only').strip()
 assert not git('ls-files','--others','--exclude-standard').strip()
for p,v in expected.items():assert h(target/p)==v,p
(evidence/(phase+'-source-binding.json')).write_text(json.dumps({'source':m['source'],'phase':phase,'hashes':expected,'manifestSha256':h(lane/'MANIFEST.json'),'productionChangedByRepair':False},indent=2)+'\n')
