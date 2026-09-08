"""Inert foreground controls for the proof supervisor; no installer code or package tools."""
import json
import os
from pathlib import Path
import sys
import time
lane=Path(__file__).resolve().parent
sys.path.insert(0,str(lane))
from process_capture import Collector

mode=sys.argv[1]
if mode=='emit':
    print('NORMAL-CONTROL')
elif mode=='overflow':
    sys.stdout.write('x'*2097152)
elif mode=='wait':
    marker=Path(sys.argv[2])
    marker.write_text(json.dumps({'pid':os.getpid(),'groupId':os.getpgrp() if os.name!='nt' else None}))
    time.sleep(60)
elif mode=='nested':
    root=Path(sys.argv[2]);root.mkdir(exist_ok=True)
    collector=Collector(root,lane)
    try:
        collector.run([sys.executable,'-I','-S',str(Path(__file__)),'wait',str(root/'started.json')],root,dict(os.environ),'inner-wait',seconds=60)
    finally:collector.finish()
elif mode=='check':
    root=Path(sys.argv[2]);root.mkdir(exist_ok=True)
    results=[]
    for name,command,seconds,pass_expected in [
        ('normal',['emit'],15,True),('overflow',['overflow'],15,False),
        ('nested-timeout',['nested',str(root/'nested-inner')],5,False)]:
        output=root/name;output.mkdir(exist_ok=True)
        collector=Collector(output,lane,own_tree=True)
        raised=False
        try:collector.run([sys.executable,'-I','-S',str(Path(__file__)),*command],root,dict(os.environ),name,seconds=seconds)
        except RuntimeError:raised=True
        finally:joined=collector.finish()
        record=collector.records[0]
        assert joined and record['quiescent'] and record['reaped'] and record['readersJoined'] and all(record['pipeEOF'].values())
        assert record['passed']==pass_expected and raised!=(pass_expected)
        if name=='normal':assert (output/(name+'.stdout')).read_text().splitlines()==['NORMAL-CONTROL'] and not record['forced']
        if name=='overflow':assert record['streams']['stdout']['bytes']==1048576 and not record['passed']
        if name=='nested-timeout':
            started=json.loads((root/'nested-inner/started.json').read_text())
            if os.name!='nt':assert started['groupId']==record['groupId']
            assert record['forced']
        results.append({'name':name,'expectedPass':pass_expected,'outcome':'expected','joined':joined})
    (root/'acceptance.json').write_text(json.dumps({'passed':True,'inertControls':results},indent=2)+'\n')
else:raise SystemExit('unknown inert control mode')
