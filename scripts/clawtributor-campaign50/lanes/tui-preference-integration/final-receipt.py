from pathlib import Path
import hashlib,json,sys
lane,evidence=(Path(p).resolve() for p in sys.argv[1:3]);m=json.loads((lane/'MANIFEST.json').read_text())
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
a=json.loads((evidence/'accepted.json').read_text());b=json.loads((evidence/'final-source-binding.json').read_text());assert a['accepted'] and b['source']==m['source'] and b['phase']=='final'
files=['accepted.json','groups.log','groups-exit.txt','fixture-lint.log','fixture-lint-exit.txt','initial-source-binding.json','patched-source-binding.json','final-source-binding.json']
(evidence/'receipt.json').write_text(json.dumps({'accepted':True,'source':m['source'],'manifestSha256':h(lane/'MANIFEST.json'),'repairProductionNetLOC':0,'nativeHeadReference':m['nativeHeadReference'],'nativeAfterHashes':m['nativeAfterHashes'],'composedAfterHashes':m['afterHashes'],'fullHelperByteIdentityClaimed':False,'fullCiShardProved':False,'agenticGroupRerun':False,'fullUiGroupProved':False,'scope':'Only28originalpreferencecases and fixturelint; fullCIshard/agentic/fullUIgroups not proved, no footer or heldscenario replay','files':{p:h(evidence/p) for p in files}},indent=2)+'\n')
