"""Admit public, pinned Node/npm bytes and construct task-local executable paths."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import urllib.request
import zipfile

def obtain_runtime(owned, lane, evidence):
    spec = json.loads((lane / 'TOOL-LOCK.json').read_text())
    key = 'windows' if os.name == 'nt' else 'linux'
    archive = spec['archives'][key]
    tools = owned / 'tools'
    tools.mkdir()
    downloaded = tools / ('node.zip' if os.name == 'nt' else 'node.tar.xz')
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(archive['url'], timeout=30) as source, downloaded.open('wb') as output:
        while data := source.read(1048576):
            total += len(data)
            if total > 134217728:
                raise RuntimeError('Node archive exceeded 128MiB admission limit')
            digest.update(data)
            output.write(data)
    if digest.hexdigest() != archive['sha256']:
        raise RuntimeError('Node archive differs from official pinned SHA256')
    extracted = tools / 'archive'
    extracted.mkdir()
    def target(name):
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or relative.parts[0] != archive['root']:
            raise RuntimeError('unexpected archive member path')
        return extracted / relative
    if os.name == 'nt':
        with zipfile.ZipFile(downloaded) as bundle:
            for member in bundle.infolist():
                dest = target(member.filename)
                if stat.S_ISLNK(member.external_attr >> 16):
                    raise RuntimeError('unexpected Windows archive link')
                if member.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(member) as src, dest.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
    else:
        links = []
        with tarfile.open(downloaded, 'r:xz') as bundle:
            for member in bundle:
                dest = target(member.name)
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as src, dest.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
                    dest.chmod(member.mode & 0o777)
                elif member.issym():
                    resolved = (dest.parent / member.linkname).resolve()
                    if not resolved.is_relative_to(extracted.resolve()):
                        raise RuntimeError('archive symlink escapes owned runtime')
                    links.append((dest, member.linkname))
                else:
                    raise RuntimeError('unexpected non-file archive member')
        for dest, value in links:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(value)
    runtime = extracted / archive['root']
    bin_dir = tools / 'bin'
    bin_dir.mkdir()
    if os.name == 'nt':
        shutil.copyfile(runtime / 'node.exe', bin_dir / 'node.exe')
        shutil.copyfile(runtime / 'npm.cmd', bin_dir / 'npm.cmd')
        shutil.copytree(runtime / 'node_modules/npm', bin_dir / 'node_modules/npm')
        node = bin_dir / 'node.exe'
        npm_cli = bin_dir / 'node_modules/npm/bin/npm-cli.js'
    else:
        (bin_dir / 'node').symlink_to(runtime / 'bin/node')
        (bin_dir / 'npm').symlink_to(runtime / 'lib/node_modules/npm/bin/npm-cli.js')
        node = bin_dir / 'node'
        npm_cli = runtime / 'lib/node_modules/npm/bin/npm-cli.js'
    package = json.loads((npm_cli.parent.parent / 'package.json').read_text())
    if package['version'] != spec['npm']:
        raise RuntimeError('bundled npm is not the admitted version')
    # Expose genuine existing platform utilities without exposing downloader/Corepack commands.
    paths = []
    utilities = ['git'] if os.name == 'nt' else ['bash','sh','env','git','cp','grep','id','stat','awk','basename','cat','chmod','date','df','dirname','head','ldd','ln','ls','mkdir','mktemp','mv','readlink','rm','sed','sort','tail','tr','uname','wc']
    for name in utilities:
        executable = shutil.which(name)
        if not executable:
            raise RuntimeError('missing admitted platform utility: ' + name)
        if os.name == 'nt':
            paths.append(str(Path(executable).parent))
        else:
            (bin_dir / name).symlink_to(executable)
    if os.name == 'nt':
        paths.extend([str(Path(os.environ['SYSTEMROOT']) / 'System32'),str(Path(os.environ['SYSTEMROOT']))])
    path_value = os.pathsep.join([str(bin_dir),*dict.fromkeys(paths)])
    if shutil.which('corepack', path=path_value):
        raise RuntimeError('unexpected Corepack in the explicit fallback environment')
    receipt = {'archive':archive,'archiveBytes':total,'sha256':digest.hexdigest(),
               'node':str(node),'nodeSha256':hashlib.sha256(node.read_bytes()).hexdigest(),
               'npm':package['version'],'npmCli':str(npm_cli),
               'npmCliSha256':hashlib.sha256(npm_cli.read_bytes()).hexdigest(),
               'path':path_value,'corepackExposed':False}
    (evidence / 'runtime-admission.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return node,npm_cli,path_value

def verify_pnpm_archives(packages, owned, lane, evidence):
    import base64
    spec=json.loads((lane/'TOOL-LOCK.json').read_text())
    keys=['pnpm','pnpmWindows' if os.name=='nt' else 'pnpmLinux']
    receipts=[]
    for key in keys:
        package=spec['npmPackages'][key]
        archive=owned/'tools'/(key+'.tgz')
        digest=hashlib.sha512();total=0
        with urllib.request.urlopen(package['tarball'],timeout=30) as source, archive.open('wb') as output:
            while data:=source.read(1048576):
                total+=len(data)
                if total>134217728:raise RuntimeError('pnpm archive admission cap')
                digest.update(data);output.write(data)
        integrity='sha512-'+base64.b64encode(digest.digest()).decode()
        if integrity!=package['integrity']:raise RuntimeError('official pnpm archive integrity mismatch')
        rows=[]
        with tarfile.open(archive,'r:gz') as bundle:
            for member in bundle:
                relative=Path(member.name)
                if relative.is_absolute() or '..' in relative.parts or relative.parts[0]!='package':raise RuntimeError('bad pnpm archive path')
                if member.isdir():continue
                if not member.isfile():raise RuntimeError('unexpected pnpm archive member kind')
                file=packages/package['name']/Path(*relative.parts[1:])
                if file.is_symlink() or not file.is_file():raise RuntimeError('installed pnpm member missing/nonregular')
                archived=bundle.extractfile(member).read()
                if file.read_bytes()!=archived:raise RuntimeError('installed pnpm differs from official archive: '+str(relative))
                rows.append({'path':str(relative),'sha256':hashlib.sha256(archived).hexdigest()})
        receipts.append({'name':package['name'],'version':package['version'],'url':package['tarball'],
                         'integrity':integrity,'archiveBytes':total,'files':rows})
    (evidence/'pnpm-archive-admission.json').write_text(json.dumps(receipts,indent=2)+'\n')
