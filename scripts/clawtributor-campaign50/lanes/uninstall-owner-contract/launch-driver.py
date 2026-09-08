"""Own the final fixture root and the sole outer process group/Windows Job Object."""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
lane=Path(__file__).resolve().parent
sys.path.insert(0,str(lane))
from process_capture import Collector
from owned_cleanup import remove_owned_tree

target,evidence,host=sys.argv[1:]
evidence=Path(evidence)
outer=evidence/'driver-process';outer.mkdir(exist_ok=True)
owned=Path(tempfile.mkdtemp(prefix='owner-127254-',dir=os.environ['TEMP'] if os.name=='nt' else os.environ['TMPDIR'])).resolve()
identity=owned.stat()
collector=Collector(outer,lane,own_tree=True)
cleanup={'ownedRoot':str(owned),'retained':True,'absent':False,'quiescent':False,'error':None}
try:
    collector.run([sys.executable,'-I','-S',str(lane/'driver.py'),target,str(evidence),host,str(owned)],
                  Path.cwd(),dict(os.environ),'complete-driver',seconds=840)
    if not collector.finish():raise RuntimeError('outer group/job completion unknown')
    selective=json.loads((evidence/'selective-cleanup.json').read_text())
    if selective['ownedRoot']!=str(owned) or not selective['readyForOuterCleanup']:
        raise RuntimeError('selective removal or guest PATH restoration incomplete')
    current=owned.lstat()
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev,current.st_ino)!=(identity.st_dev,identity.st_ino):
        raise RuntimeError('registered fixture root identity changed')
    # The driver has exited and its entire inherited group/job is observed empty.
    remove_owned_tree(owned, owned)
    cleanup.update(retained=False,absent=not os.path.lexists(owned),quiescent=True,
                   windowsPathRestored=selective['windowsPathRestored'],windowsPathAdded=selective['windowsPathAdded'])
except BaseException as error:
    cleanup['error']=type(error).__name__+': '+str(error)
    raise
finally:
    cleanup['quiescent']=collector.finish()
    (evidence/'cleanup.json').write_text(json.dumps(cleanup,indent=2)+'\n')
