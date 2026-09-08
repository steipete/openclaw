import copy,importlib.util,json
from pathlib import Path
p=Path(__file__).parent;spec=importlib.util.spec_from_file_location('reuse_reader',p/'validate-reuse.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.load(p);results=[]
def edit(args,path,fn):
 data,lineage,*_=args;v=json.loads(data[path]);fn(v);data[path]=(json.dumps(v)+'\n').encode();lineage['files'][path]['sha256']=m.sha(data[path])
def check(name,mutate=None):
 args=list(copy.deepcopy(original))
 if mutate:mutate(args)
 try:m.validate(*args)
 except (AssertionError,KeyError,StopIteration):
  assert mutate is not None;results.append({'name':name,'rejected':True})
 else:
  assert mutate is None;results.append({'name':name,'accepted':True})
check('original immutable successful behavior within failed job')
check('job relabeled green',lambda a:edit(a,'run.json',lambda x:x.update(conclusion='success')))
check('unit omitted test',lambda a:edit(a,'unit-green.json',lambda x:x.update(numTotalTests=49)))
check('original shard unhandled error',lambda a:edit(a,'unit-green.json.reports-V7rVpm/1/1/report.json.capture.json',lambda x:x['ended'].update(unhandledErrors=1)))
check('accepted retry',lambda a:edit(a,'unit-green.json.reports-V7rVpm/index.json',lambda x:x['entries'][0].update(acceptedAttempt=2)))
check('unconfirmed cleanup',lambda a:edit(a,'processes.json',lambda x:x.update(quiescent=False)))
check('forced child',lambda a:edit(a,'core-32/process.json',lambda x:x.update(forced=True)))
check('observer live group',lambda a:edit(a,'core-32/inspection-normal.json',lambda x:x.update(kernelGroupAbsent=False)))
check('missing repeated-stop control',lambda a:edit(a,'wizard-tiny-final/child.json',lambda x:x.update(repeatedStop=False)))
check('source equivalence changed',lambda a:a.__setitem__(4,a[4]+b'\n'))
(p/'REUSE-CHECKS.json').write_text(json.dumps({'dataOnly':True,'results':results},indent=2)+'\n');print(json.dumps({'accepted':True,'controls':len(results)}))
