"""Trusted Windows bootstrap controller: clear target environment and stream-cap its worker."""
import json
from pathlib import Path
import sys
lane=Path(__file__).resolve().parent
sys.path.insert(0,str(lane))
from process_capture import Collector

request=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
if sys.platform!='win32' or set(request)!={'argv','cwd','env','evidence'}:
    raise SystemExit('bad native Windows bootstrap request')
allowed={'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','PROGRAMDATA',
         'SOURCE_SHA','NODE_VERSION','PNPM_VERSION','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','ImageOS','ImageVersion',
         'PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','CI'}
if not set(request['env']).issubset(allowed):raise SystemExit('unexpected worker environment key')
if request['env'].get('SOURCE_SHA')!='f5a30f8484671abdb422a9ea8b39837a668ed019' or request['env'].get('CI')!='1':
    raise SystemExit('wrong source/CI worker environment')
evidence=Path(request['evidence'])/'bootstrap-process';evidence.mkdir(exist_ok=True)
collector=Collector(evidence,lane,own_tree=True)
try:
    collector.run(request['argv'],request['cwd'],request['env'],'complete-worker',seconds=900)
finally:
    collector.finish()
