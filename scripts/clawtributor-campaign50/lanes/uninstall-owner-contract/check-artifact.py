"""Independently join raw process streams, actual wrapper bytes and final fixture facts."""
import hashlib
import json
from pathlib import Path, PureWindowsPath
import re
import shlex
import sys

evidence=Path(sys.argv[1]);host=sys.argv[2]
load=lambda name:json.loads((evidence/name).read_text(encoding='utf-8-sig'))
processes=load('processes.json');cases=load('cases.json');cleanup=load('cleanup.json')
controls=load('supervisor-controls/acceptance.json')
assert controls['passed'] and [item['name'] for item in controls['inertControls']]==['normal','overflow','nested-timeout']
outer=load('driver-process/processes.json')
assert outer['allPassed'] and outer['quiescent'] and not outer['pending']
assert len(outer['children'])==1 and outer['children'][0]['passed'] and not outer['children'][0]['forced']
expected=['global-control','posix-git','prefix-git','prefix-npm'] if host=='linux' else ['windows-git']
assert [case['case'] for case in cases]==expected
assert processes['allCommandsJoined'] and processes['allPassed'] and not processes['pending']
assert processes['quiescent'] is None and processes['ownsTree'] is False
assert cleanup['quiescent'] and cleanup['absent'] and not cleanup['retained'] and not cleanup['error']
assert cleanup['windowsPathRestored']
rows=processes['children']
assert rows and len({row['name'] for row in rows})==len(rows)
assert all(isinstance(row['pid'],int) and row['pid']>0 for row in rows)
# OS PIDs may legitimately be reused after exit; receipts belong to each retained process object/name.
for row in rows:
    if row['name'].endswith('-owner'):
        for stream in ['stdout','stderr']:
            text=(evidence/(row['name']+'.'+stream)).read_text(errors='replace')
            assert 'retrying once' not in text and 'clearing node_modules and retrying' not in text
    assert row['passed'] and row['spawned'] and row['released'] and row['reaped'] and row['readersJoined'] and row['commandJoined']
    assert row['ownsTree'] is False and row['treeGone'] is None and row['quiescent'] is None
    assert row['treeCompletionOwner']=='outer managed group/job'
    if host=='linux':assert row['groupId']==outer['children'][0]['groupId']
    assert row['exitCode']==row['expectedExit']==0 and not row['forced'] and all(row['pipeEOF'].values())
    if host=='windows':assert outer['children'][0]['jobAccounting']['active']==0
    for stream,meta in row['streams'].items():
        data=(evidence/(row['name']+'.'+stream)).read_bytes()
        assert len(data)==meta['bytes']<=1048576 and hashlib.sha256(data).hexdigest()==meta['sha256']
def output(label):
    matches=[row for row in rows if row['name'].endswith('-'+label)]
    assert len(matches)==1,label
    return (evidence/(matches[0]['name']+'.stdout')).read_bytes()
fixture={'fixture':'127254-owner-contract','args':['owner probe with spaces','literal-value']}
for case in cases:
    name=case['case']
    assert not case['after']['lexists'] and case['after']['kind']=='absent'
    wrapper=case['after']['path']
    required_removed={wrapper}
    if name in ['posix-git','windows-git','prefix-git']:required_removed.add(case['checkout'])
    if name=='prefix-git':required_removed.add(case['prefix'])
    if name=='prefix-npm':required_removed.add(str(Path(case['prefix'])/'tools/node-v24.20.0/lib/node_modules/openclaw'))
    if name=='global-control':required_removed.add(str(Path(case['prefix'])/'lib/node_modules/openclaw'))
    assert {item['path'] for item in case['removed']}==required_removed
    assert len(case['removed'])==len(required_removed)
    assert all(not item['lexists'] and not item['exists'] and item['kind']=='absent' for item in case['removed'])
    required_markers={'global-control':['unrelated.txt'],'posix-git':['unrelated.txt','.bashrc'],
        'prefix-git':['unrelated.txt','state.txt','workspace.txt','custom-config.txt'],
        'prefix-npm':['unrelated.txt','state.txt','workspace.txt','custom-config.txt','shared-tool.txt','package.json','node'],
        'windows-git':['unrelated.txt']}[name]
    path_type=PureWindowsPath if host=='windows' else Path
    assert sorted(path_type(item['path']).name for item in case['preserved'])==sorted(required_markers)
    if name=='global-control':assert json.loads(output('global-before'))==fixture
    else:
        assert json.loads(output(name+'-before'))==fixture
        assert json.loads(output(name+'-after-wrong-owner'))==fixture
        raw=(evidence/(name+'-wrapper.txt')).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==case['produced']['sha256']
        lines=raw.decode().splitlines()
        if host=='windows':
            assert lines[0]=='@echo off' and len(lines)==2
            match=re.fullmatch(r'node "(.+)" %\*',lines[1]);assert match
            assert PureWindowsPath(match[1])==PureWindowsPath(case['checkout'])/'dist/entry.js'
        else:
            assert lines[:2]==['#!/usr/bin/env bash','set -euo pipefail'] and len(lines)==3
            parts=shlex.split(lines[2]);assert len(parts)==4 and parts[0]=='exec' and parts[3]=='$@'
            expected_entry=(Path(case['prefix'])/'tools/node-v24.20.0/lib/node_modules/openclaw/dist/entry.js') if name=='prefix-npm' else Path(case['checkout'])/'dist/entry.js'
            assert Path(parts[2])==expected_entry
        assert case['preserved'] and all(row['exists'] and row['sha256'] for row in case['preserved'])
    assert case['preserved'] and all(item['lexists'] and item['exists'] and item['sha256'] for item in case['preserved'])
    for marker in case['preserved']:
        leaf=(PureWindowsPath if host=='windows' else Path)(marker['path']).name
        if leaf=='unrelated.txt':expected_bytes=('retain-global-sibling\n' if name=='global-control' else 'retain-shared-bin\n').encode()
        elif leaf in ['state.txt','workspace.txt','custom-config.txt','shared-tool.txt']:expected_bytes=('retain-'+leaf[:-4]+'\n').encode()
        elif leaf=='package.json':expected_bytes=b'{"name":"unrelated-fixture","version":"0.0.0"}\n'
        elif leaf=='.bashrc':
            expected_bytes=(evidence/(name+'-profile.txt')).read_bytes()
            assert expected_bytes.count(b'# retain unrelated profile content\n')==1
        elif leaf=='node':
            assert marker['sha256']==load('runtime-admission.json')['nodeSha256']
            continue
        else:raise AssertionError('unexpected preserved fixture '+leaf)
        assert hashlib.sha256(expected_bytes).hexdigest()==marker['sha256']
runtime=load('runtime-admission.json');tools=load('platform-tools.json');pnpm=load('pnpm-admission.json')
assert tools['node']=='24.20.0' and tools['npm']=='11.19.0' and pnpm['version']=='12.3.4'
assert runtime['npm']=='11.19.0' and runtime['corepackExposed'] is False
tool_lock=json.loads((Path(__file__).parent/'TOOL-LOCK.json').read_text())
expected_archive=tool_lock['archives'][host]
assert runtime['archive']==expected_archive and runtime['sha256']==expected_archive['sha256']
admitted_archives=load('pnpm-archive-admission.json')
expected_tools=[tool_lock['npmPackages']['pnpm'],tool_lock['npmPackages']['pnpmWindows' if host=='windows' else 'pnpmLinux']]
assert len(admitted_archives)==2
for observed,wanted in zip(admitted_archives,expected_tools):
    assert observed['name']==wanted['name'] and observed['version']==wanted['version']
    assert observed['url']==wanted['tarball'] and observed['integrity']==wanted['integrity']
    assert observed['files'] and all(re.fullmatch('[0-9a-f]{64}',row['sha256']) for row in observed['files'])
if host=='windows':
    assert load('windows-path-before.json')['entry']==cleanup['windowsPathAdded']
    restored=json.loads(output('windows-path-restore'));assert restored['restored'] and restored['exactOriginal']
print(json.dumps({'passed':True,'host':host,'cases':expected,'joinedChildren':len(rows),
                  'actualInstallerProducers':True,'syntheticTargets':True,'fullOpenClawInstallProof':False,
                  'wrongGlobalOwnerLeavesGitPrefixLaunchers':True,'correctOwnerRemovalAndPreservation':True,'processContainmentScope':'inherited foreground command group/job; no generic daemon/detach claim',
                  'ownedTreeRemoved':True,'nativeMacOrWslProof':False},indent=2))
