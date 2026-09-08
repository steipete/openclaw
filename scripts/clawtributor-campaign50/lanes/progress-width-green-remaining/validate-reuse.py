import hashlib,json,re,sys
from pathlib import Path

sha=lambda b:hashlib.sha256(b).hexdigest()
strip=lambda t:re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',re.sub(r'\x1b\].*?(?:\x07|\x1b\\)','',t,flags=re.S))
PASSED=['conflict markers','max-lines suppression ratchet','assertion SAFETY comment ratchet','changelog attributions','doctor deprecation registry','guarded extension wildcard re-exports','plugin-sdk wildcard re-exports','duplicate scan target coverage','dependency pin guard','format changed files','plugin boundaries','wrapper shadowing','package patch guard','test temp creation report (warning-only)','core tsgo graph boundary','typecheck core','typecheck core tests','coercion helper declaration guard','deprecated API usage','dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)']

def validate(data,lineage,repair,before,after):
 def raw(name):return data[name]
 def text(name):return raw(name).decode('utf-8')
 def rd(name):return json.loads(raw(name))
 assert set(data)==set(lineage['files'])
 for f,entry in lineage['files'].items():assert sha(raw(f))==entry['sha256'],f
 run=rd('run.json');assert run['databaseId']==lineage['run']==34169880359 and run['headSha']==lineage['harness']=='dd26a9d5d23978616e97ef11cda50c149fdc0d91' and run['status']=='completed' and run['conclusion']=='failure'
 job=next(j for j in run['jobs'] if j['databaseId']==lineage['job']);assert job['databaseId']==101888055019 and job['status']=='completed' and job['conclusion']=='failure'
 assert lineage['source']=='6aa09cbadb594c3d46d5bd49a28c514df1b256b0'
 inp=rd('input-before.json');packet=rd('harness/PACKET.json');assert inp['packetSha256']==lineage['packetSha256']==sha(raw('harness/PACKET.json'));assert inp['files']==packet['files']
 for name in ['cases.json','SOURCE-TESTS.json','source.sha256','source-green.sha256','check.mts','child.mts','driver.py','inspect-group.mjs','validate-tests.mjs','completed-report.mjs','run.sh']:assert sha(raw('harness/'+name))==inp['files'][name],name
 src=rd('source.json');assert src['source']==lineage['source'] and src['node']=='24.20.0' and src['lane']=='progress-width-green' and src['mode']=='green' and src['packageManager'].startswith('pnpm@12.3.4+')
 for file,pins in [('source-before.log.txt','harness/source.sha256'),('candidate-before.log.txt','harness/source-green.sha256')]:
  expected=[line.split('  ',1)[1]+': OK' for line in text(pins).splitlines()];assert len(expected)==23 and text(file).splitlines()==expected
 assert text('unit-green-exit.txt').strip()=='0' and text('exit-code.txt').strip()=='1'
 assert text('driver.log.txt')==text('check.log.txt')==''
 assert rd('unit-acceptance.json')=={'accepted':True,'files':2,'passed':50,'failed':0}
 assert rd('acceptance.json')=={'accepted':True,'mode':'green','cases':12,'failures':[]}
 unit=rd('unit-green.json');assert unit['success'] and unit['numTotalTests']==unit['numPassedTests']==50
 for key in ['numFailedTests','numPendingTests','numTodoTests','numFailedTestSuites','numPendingTestSuites']:assert unit[key]==0
 assert len(unit['testResults'])==2
 for suite in unit['testResults']:
  assert suite['status']=='passed' and suite['message']==''
  for case in suite['assertionResults']:assert case['status']=='passed' and case['failureMessages']==[]
 idx=rd('unit-green.json.reports-V7rVpm/index.json');assert idx['complete'] and idx['error']=='' and len(idx['entries'])==2
 good={'code':0,'noOutputTimedOut':False,'signal':None,'groupJoined':True};assert idx['merge']==good
 for entry,count in zip(idx['entries'],[15,35]):
  assert entry['state']=='finished' and entry['acceptedAttempt']==1 and len(entry['attempts'])==1 and entry['attempts'][0]['outcome']==good
  stem='unit-green.json.reports-V7rVpm/'+str(entry['invocation'])+'/1/report.json';report=rd(stem);cap=rd(stem+'.capture.json')
  assert entry['attempts'][0]['json'].endswith('/'+stem)
  assert report['success'] and report['numTotalTests']==report['numPassedTests']==count
  for key in ['numFailedTests','numPendingTests','numTodoTests','numFailedTestSuites','numPendingTestSuites']:assert report[key]==0
  assert cap['ended']=={'reason':'passed','unhandledErrors':0,'failedModules':0,'suiteErrors':0}
  assert not cap['processTimedOut'] and not cap['ignoreUnhandledErrors'] and not cap['passWithNoTests']
  assert len(cap['modules'])==1 and cap['modules'][0]['file'].endswith('/'+entry['includePatterns'][0])
 assert not re.search(r'\[test\]\s+retrying|no-output timeout|FATAL ERROR:|out of memory|unfinished|Unhandled Error',strip(text('unit-green.log.txt')),re.I)
 checks=strip(text('check-changed.log.txt'));assert re.findall(r'^\s*\S+\s+ok\s+(.+)$',checks,re.M)==PASSED
 assert checks.count('typescript(unbound-method)')==2 and ':248:31]' in checks and ':266:29]' in checks and 'Found 0 warnings and 2 errors.' in checks and '[check:changed] FAILED (exit 1)' in checks
 cases=rd('harness/cases.json');procs=rd('processes.json');assert len(cases)==len(procs['records'])==len(procs['inspections'])==12
 assert procs['quiescent'] and procs['ownedFixtureRemoved'] and procs['retainedState'] is None and procs['cancelledSignal'] is None
 assert len({p['pid'] for p in procs['records']}|{p['observerPid'] for p in procs['inspections']})==24
 results=[]
 for i,cell in enumerate(cases):
  stem=cell['id']+'/';p=rd(stem+'process.json');o=rd(stem+'inspection-normal.json');child=rd(stem+'child.json');screen=rd(stem+'screen.json');b=raw(stem+'raw.ansi');t=b.decode('utf-8')
  assert p==procs['records'][i] and o==procs['inspections'][i]
  assert all(p[k] is True for k in ['spawned','joined','eof']) and p['exitCode']==0 and not p['forced'] and p['groupState']=='dead' and 'error' not in p
  assert len(b)==p['rawBytes'] and sha(b)==p['rawSha256']
  assert all(o[k] is True for k in ['spawned','reaped','pipeEOF','kernelGroupAbsent']) and o['forcedSignals']==[] and o['exitCode']==0 and o['canonicalState']=='dead' and 'error' not in o
  obs=rd(stem+'inspection-normal.stdout');assert obs==o['observation'] and raw(stem+'inspection-normal.stderr')==b''
  assert obs['pid']==p['pid']==o['targetPid'] and obs['observerPid']==o['observerPid'] and obs['policy']=='indeterminate' and obs['canonicalState']=='dead' and obs['observationValid'] and obs['builtinBindingsRestored']
  assert len(obs['observations'])==1 and obs['observations'][0]['kind']=='kernel' and obs['observations'][0]['pid']==-p['pid'] and obs['observations'][0]['signal']==0 and obs['observations'][0]['error']['code']=='ESRCH'
  assert child['completed'] and child['listenersRestored'] and child['rawInputRestored'] and child['suppressed']==cell['expectSuppressed'] and child['repeatedStop']==cell.get('repeatStop',False)
  assert child['columns']==cell.get('finalColumns',cell['columns']) and child['initialColumns']==cell['columns']
  label=cell.get('label','Checking channel status (probe)…');updated=label.replace('Scanning','Checking') if 'label' in cell else 'Checking channel status (ready)…'
  assert re.findall(r'\x1b\]9;4;.*?\x1b\\',t,re.S)==['\x1b]9;4;3;;'+label+'\x1b\\','\x1b]9;4;3;;'+updated+'\x1b\\','\x1b]9;4;0;0;'+updated+'\x1b\\']
  phases=['begin']+(['resize-request'] if cell['kind']=='delayed' else [])+(['suppressed'] if child['suppressed'] else [])+['updated','active','done','settled'];assert re.findall(r'\x1b\]777;progress-proof;([^\x07]+)\x07',t)==phases and t.endswith('\x1b]777;progress-proof;settled\x07')
  pattern=r'\((?:\\/|\|\||--)\)' if cell['kind']=='wizard' else r'[◒◐◓◑•oO0]  '
  assert [r['byte'] for r in p['readySignals']]==['S','A']
  for n,r in enumerate(p['readySignals']):
   assert 0<r['offset']<=len(b);prefix=b[:r['offset']].decode('utf-8');count=len(re.findall(pattern,strip(prefix)));assert count==r['frames'];assert (count==0 if child['suppressed'] else count>=(1 if n==0 else 26))
   if n==1:assert '\x1b]777;progress-proof;updated\x07' in prefix
  active=t.index('\x1b]777;progress-proof;active\x07');done=t.index('\x1b]777;progress-proof;done\x07');completion=strip(t[active+len('\x1b]777;progress-proof;active\x07'):done]).replace('\r\n','\n').replace('\r','');expected=('' if 'finalMessage' not in cell else '◇  '+cell['finalMessage']+'\n') if cell['kind']=='wizard' else '◇  \n';assert completion==expected
  assert screen['done']==screen['settled'] and len([x for x in screen['active'] if x])==(0 if child['suppressed'] else 2)
  if cell['kind']=='delayed':assert strip(b[:p['resizeByteOffset']].decode())=='' and p['resizeApplied']
  if cell['id']=='wizard-unicode':assert '👨‍👩‍👧‍👦' in strip(t[:active]) and '…' in strip(t[:active])
  results.append(cell['id'])
 outcomes=rd('outcomes.json');assert outcomes['failures']==[] and [r['id'] for r in outcomes['results']]==results and all(r['conforms'] for r in outcomes['results'])
 assert sha(before)==repair['beforeWizardHash']=='4f50ae8ff9bde6f0acf727d6a9b58d6600c66f3d37acba6c335dd7c63d5fe458' and sha(after)==repair['afterWizardHash']=='9bdfeb7af6fc0aa8a2d6f3ebd763f01e73eec653d23f74a2b33fe78e4feec28e'
 expected=before.decode().replace('import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";','import {\n  afterAll,\n  afterEach,\n  beforeEach,\n  describe,\n  expect,\n  it,\n  onTestFinished,\n  vi,\n  type MockInstance,\n} from "vitest";').replace('describe("createClackPrompter", () => {\n  beforeEach','describe("createClackPrompter", () => {\n  let write: MockInstance<typeof process.stdout.write>;\n\n  beforeEach').replace('    vi.spyOn(process.stdout, "write").mockImplementation(() => true);','    write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);').replace('      const write = vi.mocked(process.stdout.write);\n','').replace('    const write = vi.mocked(process.stdout.write);\n','')
 assert after.decode()==expected
 return {'accepted':True,'originalRun':lineage['run'],'originalJobConclusion':'failure','originalWizardHash':repair['beforeWizardHash'],'candidateWizardHash':repair['afterWizardHash'],'unitPasses':50,'ptyCases':results,'naturalProcessReceipts':24,'staticPassed':PASSED,'remaining':'fresh lint, eight later static checks, final guards','equivalence':'same existing beforeEach spy handle and unchanged assertions; old execution remains attributed to old test hash'}

def load(lane):
 lineage=json.loads((lane/'REUSE-LINEAGE.json').read_text());data={f:(lane/'reuse'/f).read_bytes() for f in lineage['files']};repair=json.loads((lane/'REPAIR.json').read_text());return data,lineage,repair,(lane/'before.test.ts').read_bytes(),(lane/'after.test.ts').read_bytes()
if __name__=='__main__':print(json.dumps(validate(*load(Path(sys.argv[1])))))
