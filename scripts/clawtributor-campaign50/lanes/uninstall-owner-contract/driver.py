"""Actual installer ownership over synthetic targets; never run against a user's install."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import time

LANE = Path(__file__).resolve().parent
sys.path.insert(0, str(LANE))
from process_capture import Collector
from owned_cleanup import remove_owned_tree
from tooling import obtain_runtime, verify_pnpm_archives

SOURCE = 'f5a30f8484671abdb422a9ea8b39837a668ed019'
SENTINELS = ['owner probe with spaces', 'literal-value']
FIXTURE = {'fixture':'127254-owner-contract', 'args':SENTINELS}

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
    target, evidence, host = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    if host not in ['linux','windows'] or sys.platform != ('win32' if host=='windows' else 'linux'):
        raise RuntimeError('wrong host route')
    if SOURCE != os.environ.get('SOURCE_SHA') or os.environ.get('CI') != '1':
        raise RuntimeError('wrong source/isolated environment')
    if not ((3,12) <= sys.version_info[:2] <= (3,14)):
        raise RuntimeError('Python outside reviewed platform contract')
    evidence.mkdir(exist_ok=True)
    # This fresh directory is the sole registry root for every installed or removed fixture.
    owned = Path(sys.argv[4]).resolve()
    if not owned.is_dir() or owned.is_symlink() or any(owned.iterdir()):
        raise RuntimeError('driver requires the fresh empty root created by its outer owner')
    collector = Collector(evidence, LANE)
    cases = []
    error = None
    index = 0
    case_deadline = None
    windows_path_added = None
    windows_path_receipt = None
    cleanup_env = None
    pwsh = None
    def within(path):
        path = Path(path)
        if path == owned or not path.absolute().is_relative_to(owned) or not path.parent.resolve().is_relative_to(owned):
            raise RuntimeError('mutation outside registered owned root: ' + str(path))
        return path
    def remove(path):
        path = within(path)
        if path.is_symlink():
            path.unlink()
        elif path.is_dir():
            if collector.pending or any(not row.get('passed') or not row.get('commandJoined') for row in collector.records):
                raise RuntimeError('selective cleanup requires normal command completion')
            remove_owned_tree(path, owned)
        elif path.exists():
            path.unlink()
    def run(argv, cwd, env, label, seconds=120, expected=0):
        nonlocal index
        if case_deadline is not None:
            seconds=min(seconds,case_deadline-time.monotonic())
            if seconds<=0:raise TimeoutError('entire ownership case exceeded120seconds')
        index += 1
        return collector.run([str(a) for a in argv], cwd, env, f'{index:03}-{label}', seconds, expected)
    def facts(path):
        path = Path(path)
        present=os.path.lexists(path)
        kind='absent' if not present else 'symlink' if path.is_symlink() else 'directory' if path.is_dir() else 'file'
        return {'path':str(path), 'exists':path.exists(), 'lexists':present, 'kind':kind, 'symlink':path.is_symlink(),
                'sha256':digest(path) if path.is_file() else None}
    try:
        node,npm_cli,tool_path = obtain_runtime(owned, LANE, evidence)
        home = owned/'home';home.mkdir()
        temp = owned/'tmp';temp.mkdir()
        cache = owned/'npm-cache';cache.mkdir()
        user_config = owned/'user.npmrc';user_config.write_text('')
        global_config = owned/'global.npmrc';global_config.write_text('')
        empty_git = owned/'empty.gitconfig';empty_git.write_text('')
        env = {'PATH':tool_path,'HOME':str(home),'USERPROFILE':str(home),'CI':'1','LANG':'C.UTF-8','TZ':'UTC',
               'TMPDIR':str(temp),'TMP':str(temp),'TEMP':str(temp),'NPM_CONFIG_CACHE':str(cache),
               'NPM_CONFIG_USERCONFIG':str(user_config),'NPM_CONFIG_GLOBALCONFIG':str(global_config),
               'NPM_CONFIG_AUDIT':'false','NPM_CONFIG_FUND':'false','NPM_CONFIG_REGISTRY':'https://registry.npmjs.org',
               'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(empty_git),
               'GIT_AUTHOR_NAME':'Synthetic ownership fixture','GIT_AUTHOR_EMAIL':'fixture@example.invalid',
               'GIT_COMMITTER_NAME':'Synthetic ownership fixture','GIT_COMMITTER_EMAIL':'fixture@example.invalid',
               'GIT_AUTHOR_DATE':'2026-09-08T00:00:00Z','GIT_COMMITTER_DATE':'2026-09-08T00:00:00Z',
               'OPENCLAW_NO_ONBOARD':'1','OPENCLAW_NO_PROMPT':'1','OPENCLAW_VERBOSE':'1'}
        pwsh = None
        if os.name == 'nt':
            for key in ['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','PROGRAMDATA','GITHUB_ACTIONS','RUNNER_ENVIRONMENT']:
                if key in os.environ:env[key]=os.environ[key]
            env['APPDATA']=str(home/'AppData/Roaming');env['LOCALAPPDATA']=str(home/'AppData/Local')
            Path(env['APPDATA']).mkdir(parents=True);Path(env['LOCALAPPDATA']).mkdir(parents=True)
            pwsh = shutil.which('pwsh')
            if not pwsh:raise RuntimeError('native pwsh missing')
        else:
            env['SHELL']=str(Path(tool_path.split(os.pathsep)[0])/'bash')
        git = shutil.which('git', path=tool_path)
        runtime_version=run([node,'-p','process.versions.node'],owned,env,'node-version').decode().strip()
        npm_version=run([node,npm_cli,'--version'],owned,env,'npm-version').decode().strip()
        git_version=run([git,'--version'],owned,env,'git-version').decode().strip()
        if runtime_version!='24.20.0' or npm_version!='11.19.0' or not git_version.startswith('git version 2.'):
            raise RuntimeError('tool version contract mismatch')
        platform_receipt={'host':host,'python':sys.version,'pythonPath':sys.executable,'pythonSha256':digest(sys.executable),
                          'subprocessSha256':digest(subprocess.__file__),'node':runtime_version,'npm':npm_version,
                          'git':git_version,'gitPath':git,'gitSha256':digest(git),'platform':platform.platform(),
                          'machine':platform.machine(),'imageOS':os.environ.get('ImageOS'),'imageVersion':os.environ.get('ImageVersion')}
        if pwsh:
            ps=run([pwsh,'-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],owned,env,'powershell-version').decode().strip()
            if not ps.startswith('7.'):raise RuntimeError('PowerShell outside reviewed contract')
            platform_receipt.update(powershell=ps,powershellPath=pwsh,powershellSha256=digest(pwsh))
        (evidence/'platform-tools.json').write_text(json.dumps(platform_receipt,indent=2)+'\n')
        # Normal tool acquisition, isolated from the real owner cases; no target source runs here.
        tool_prefix=owned/'pnpm-admission'
        run([node,npm_cli,'install','-g','--prefix',tool_prefix,'pnpm@12.3.4','--ignore-scripts'],owned,env,'admit-pnpm',120)
        packages=tool_prefix/('node_modules' if os.name=='nt' else 'lib/node_modules')
        verify_pnpm_archives(packages,owned,LANE,evidence)
        native_package='@pnpm/exe.win32-x64' if os.name=='nt' else '@pnpm/exe.linux-x64'
        native_bin=packages/native_package/('pnpm.exe' if os.name=='nt' else 'pnpm')
        actual_pnpm=run([native_bin,'--version'],owned,env,'pnpm-version').decode().strip()
        if actual_pnpm!='12.3.4':raise RuntimeError('wrong admitted pnpm')
        tool_lock=json.loads((LANE/'TOOL-LOCK.json').read_text())
        admitted=[]
        for key,name in [('pnpm','pnpm'),('pnpmWindows' if os.name=='nt' else 'pnpmLinux',native_package)]:
            manifest=json.loads((packages/name/'package.json').read_text())
            expected=tool_lock['npmPackages'][key]
            if manifest['name']!=expected['name'] or manifest['version']!=expected['version']:raise RuntimeError('pnpm package identity mismatch')
            admitted.append({'name':name,'version':manifest['version'],'packageJsonSha256':digest(packages/name/'package.json')})
        (evidence/'pnpm-admission.json').write_text(json.dumps({'packages':admitted,'nativeSha256':digest(native_bin),'version':actual_pnpm},indent=2)+'\n')
        user_config.write_text('offline=true\nregistry=https://registry.npmjs.org\n')
        env['NPM_CONFIG_OFFLINE']='true';env['PNPM_CONFIG_OFFLINE']='true'
        env['PNPM_CONFIG_STORE_DIR']=str(owned/'pnpm-store')
        env['NPM_CONFIG_PREFIX']=str(owned/'ambient-global')
        env['GIT_TERMINAL_PROMPT']='0'
        def prepare(name):
            root=owned/name;root.mkdir();repo=root/'checkout with spaces'
            shutil.copytree(LANE/'fixture',repo)
            hooks=root/'empty-hooks';hooks.mkdir()
            # Build/package the labeled fixture with real Node/npm; never the OpenClaw application.
            run([node,'fixture-build.mjs','cli'],repo,env,name+'-fixture-build')
            run([node,npm_cli,'pack','--ignore-scripts','--json'],repo,env,name+'-fixture-pack')
            run([git,'init','--initial-branch=main',repo],root,env,name+'-git-init')
            run([git,'-C',repo,'config','core.hooksPath',hooks],root,env,name+'-git-hooks')
            run([git,'-C',repo,'add','.'],root,env,name+'-git-add')
            run([git,'-C',repo,'commit','-m','synthetic fixture'],root,env,name+'-git-commit')
            return root,repo
        def invoke(wrapper, case_env, name):
            if os.name=='nt':
                request=owned/(name+'.json');request.write_text(json.dumps({'command':str(wrapper),'arguments':SENTINELS}))
                data=run([pwsh,'-NoProfile','-NonInteractive','-File',LANE/'invoke-windows.ps1','-RequestFile',request],owned,case_env,name)
            else:data=run([wrapper,*SENTINELS],owned,case_env,name)
            if json.loads(data)!=FIXTURE:raise RuntimeError('real launcher lost fixture identity/arguments')
            return json.loads(data)
        # A correct package-manager row removes its own global package, leaving siblings untouched.
        if host=='linux':
            case_deadline=time.monotonic()+120
            root,repo=prepare('global-control');global_prefix=root/'global';global_prefix.mkdir()
            sibling=global_prefix/'unrelated.txt';sibling.write_text('retain-global-sibling\n');before=digest(sibling)
            run([node,npm_cli,'install','-g','--prefix',global_prefix,repo/'openclaw-0.0.0-synthetic-owner-proof.tgz','--ignore-scripts'],owned,env,'global-install')
            wrapper=global_prefix/'bin/openclaw';before_wrapper=facts(wrapper);probe=invoke(wrapper,env,'global-before')
            run([node,npm_cli,'rm','-g','--prefix',global_prefix,'openclaw'],owned,env,'global-remove')
            assert not os.path.lexists(wrapper) and not os.path.lexists(global_prefix/'lib/node_modules/openclaw') and digest(sibling)==before
            cases.append({'case':'global-control','prefix':str(global_prefix),'checkout':str(repo),'before':before_wrapper,'probe':probe,'after':facts(wrapper),'removed':[facts(wrapper),facts(global_prefix/'lib/node_modules/openclaw')],'preserved':[facts(sibling)]})
        names=['windows-git'] if host=='windows' else ['posix-git','prefix-git','prefix-npm']
        for name in names:
            case_deadline=time.monotonic()+120
            root,repo=prepare(name);prefix=root/'prefix';case_home=root/'home';case_home.mkdir()
            case_env={**env,'HOME':str(case_home),'USERPROFILE':str(case_home)}
            if os.name=='nt':
                case_env['APPDATA']=str(case_home/'AppData/Roaming');case_env['LOCALAPPDATA']=str(case_home/'AppData/Local')
                Path(case_env['APPDATA']).mkdir(parents=True);Path(case_env['LOCALAPPDATA']).mkdir(parents=True)
            else:(case_home/'.bashrc').write_text('# retain unrelated profile content\n')
            bin_dir=case_home/'.local/bin';bin_dir.mkdir(parents=True)
            sibling=bin_dir/'unrelated.txt';sibling.write_text('retain-shared-bin\n');sibling_before=digest(sibling)
            if os.name=='nt':
                # The real producer may add this exact task-owned path to the disposable guest user PATH.
                windows_path_added=str(bin_dir)
                windows_path_receipt=owned/'user-path-before.json'
                cleanup_env=case_env
                run([pwsh,'-NoProfile','-NonInteractive','-File',LANE/'path-state.ps1','-Operation','capture','-Entry',bin_dir,'-Receipt',windows_path_receipt],owned,case_env,'windows-path-capture')
                shutil.copyfile(windows_path_receipt,evidence/'windows-path-before.json')
                run([pwsh,'-NoProfile','-NonInteractive','-File',LANE/'owner-windows.ps1','-LaneDir',LANE,'-RepoDir',repo,'-SourceSha',SOURCE],repo,case_env,'windows-owner')
                wrapper=bin_dir/'openclaw.cmd'
            else:
                run([shutil.which('bash',path=tool_path),LANE/'owner-posix.sh',LANE,name,repo,prefix,SOURCE],repo,case_env,name+'-owner')
                wrapper=bin_dir/'openclaw' if name=='posix-git' else prefix/'bin/openclaw'
            produced=facts(wrapper);produced_bytes=wrapper.read_bytes()
            (evidence/(name+'-wrapper.txt')).write_bytes(produced_bytes)
            first=invoke(wrapper,case_env,name+'-before')
            run([node,npm_cli,'rm','-g','--prefix',owned/'ambient-global','openclaw'],owned,case_env,name+'-wrong-owner-remove')
            assert wrapper.read_bytes()==produced_bytes
            after_wrong=invoke(wrapper,case_env,name+'-after-wrong-owner')
            retained=[]
            removed=[wrapper]
            if name=='prefix-git':
                keep=root/'preserved';keep.mkdir()
                for label in ['state','workspace','custom-config']:
                    marker=prefix/(label+'.txt');marker.write_text('retain-'+label+'\n')
                    dest=keep/marker.name;shutil.move(marker,dest);retained.append(facts(dest))
                remove(wrapper);remove(prefix);remove(repo)
                removed.extend([prefix,repo])
            elif name=='prefix-npm':
                for label in ['state','workspace','custom-config','shared-tool']:
                    marker=prefix/(label+'.txt');marker.write_text('retain-'+label+'\n');retained.append(facts(marker))
                peer=prefix/'tools/node-v24.20.0/lib/node_modules/unrelated-fixture/package.json'
                peer.parent.mkdir(parents=True)
                peer.write_text('{"name":"unrelated-fixture","version":"0.0.0"}\n')
                retained.append(facts(peer))
                runtime=prefix/'tools/node/bin/node';runtime_before=digest(runtime)
                run([node,npm_cli,'rm','-g','--prefix',prefix/'tools/node-v24.20.0','openclaw'],owned,case_env,name+'-right-owner-remove')
                remove(wrapper)
                removed.append(prefix/'tools/node-v24.20.0/lib/node_modules/openclaw')
                assert digest(runtime)==runtime_before
                retained.append(facts(runtime))
            else:
                remove(wrapper);remove(repo)
                removed.append(repo)
            assert all(not os.path.lexists(path) for path in removed) and digest(sibling)==sibling_before
            assert all(Path(row['path']).exists() and digest(row['path'])==row['sha256'] for row in retained)
            fresh_env={**case_env,'PATH':str(wrapper.parent)+os.pathsep+tool_path}
            if os.name=='nt':
                run([pwsh,'-NoProfile','-NonInteractive','-Command',"if (Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue) { exit 1 }"],owned,fresh_env,name+'-fresh-resolution')
            else:
                run([shutil.which('bash',path=tool_path),'-c','if command -v openclaw; then exit 1; fi'],owned,fresh_env,name+'-fresh-resolution')
            if name=='posix-git':
                profile=case_home/'.bashrc'
                assert '# retain unrelated profile content\n' in profile.read_text()
                (evidence/(name+'-profile.txt')).write_bytes(profile.read_bytes())
                retained.append(facts(profile))
            cases.append({'case':name,'checkout':str(repo),'prefix':str(prefix),'produced':produced,'before':first,'afterWrongOwner':after_wrong,
                          'after':facts(wrapper),'removed':[facts(path) for path in removed],'preserved':[facts(sibling),*retained]})
        (evidence/'cases.json').write_text(json.dumps(cases,indent=2)+'\n')
    except BaseException as exc:
        error=type(exc).__name__+': '+str(exc)
        raise
    finally:
        case_deadline = None
        path_restored = windows_path_added is None
        if windows_path_added and not collector.pending:
            try:
                run([pwsh,'-NoProfile','-NonInteractive','-File',LANE/'path-state.ps1','-Operation','restore','-Entry',windows_path_added,'-Receipt',windows_path_receipt],owned,cleanup_env,'windows-path-restore')
                path_restored = True
            except BaseException as cleanup_error:
                error = (error or '') + '; PATH restore: ' + str(cleanup_error)
        commands_joined=collector.finish()
        cleanup={'ownedRoot':str(owned),'allCommandsJoined':commands_joined,'error':error,
                 'windowsPathAdded':windows_path_added,'windowsPathRestored':path_restored,
                 'readyForOuterCleanup':commands_joined and path_restored and error is None}
        # Only the outer owner can observe the managed group empty after this driver exits.
        (evidence/'selective-cleanup.json').write_text(json.dumps(cleanup,indent=2)+'\n')

if __name__=='__main__':main()
