"""Secretless current-merge plan report; never an original-CI replay."""
from pathlib import Path
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback

os.umask(0o077)
assets = Path(__file__).resolve().parent
checkout, evidence = [Path(value).resolve() for value in sys.argv[1:3]]
evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
binding = json.loads((assets / 'plan-binding.json').read_text())
proof_root = assets.parents[3]
receipt = {'schema': 'openclaw-126547-current-merge-plan-v1', 'passed': False, 'phase': 'setup',
           'planOnly': True, 'testsExecuted': False, 'originalFailedCiCheckoutProven': False,
           'originalFailedCiWorkflowRevisionProven': False,
           'commands': [], 'unconfirmedCommandGroups': [], 'cleanupErrors': []}
scratch = node = installed_lock = initial_guard = None
manifest = manifest_bytes = None
MAX_LOG_BYTES = 16 * 1024 * 1024
index_observations = []
index_capture_bytes = {}

def sha(data):
    return hashlib.sha256(data).hexdigest()



def digest(file):
    return sha(Path(file).read_bytes())



def save(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')



def retain_index(file):
    # Index files contain public tracked paths and stat metadata, never Git config.
    assert not file.is_symlink() and file.is_file()
    with file.open('rb') as source:
        metadata = os.fstat(source.fileno())
        assert metadata.st_size <= 8 * 1024 * 1024, 'Index diagnostic exceeds bound'
        data = source.read(8 * 1024 * 1024 + 1)
    assert len(data) == metadata.st_size and data[:4] == b'DIRC'
    identity = sha(data)
    directory = evidence / 'index-diagnostics'
    directory.mkdir(exist_ok=True)
    assert not directory.is_symlink()
    if identity not in index_capture_bytes:
        assert sum(index_capture_bytes.values()) + len(data) <= 24 * 1024 * 1024
        (directory / (identity + '.index')).write_bytes(data)
        index_capture_bytes[identity] = len(data)
    return {'sha256': identity, 'bytes': len(data), 'mtimeNs': metadata.st_mtime_ns,
            'ctimeNs': metadata.st_ctime_ns, 'inode': metadata.st_ino,
            'observedAtUnixNs': time.time_ns()}



def git(*args, cwd=checkout):
    argv = ['/usr/bin/git', '-c', 'core.fsmonitor=false', *args]
    env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
    if cwd != checkout:
        return subprocess.check_output(argv, cwd=cwd, env=env)
    index = checkout / '.git/index'
    assert (checkout / '.git').is_dir() and not (checkout / '.git').is_symlink()
    observation = {'argv': argv, 'before': retain_index(index)}
    assert len(index_observations) < 512
    try:
        if args[0] == 'diff':
            # Porcelain diff may refresh stat metadata despite optional-locks=0.
            # Keep its content comparison intact while it owns only a disposable copy.
            with tempfile.TemporaryDirectory(prefix='diff-index-', dir=evidence) as temporary:
                comparison = Path(temporary) / 'index'
                comparison.write_bytes((evidence / 'index-diagnostics' / (observation['before']['sha256'] + '.index')).read_bytes())
                # Git uses index mtime for its racy-stat test; preserve that input too.
                os.utime(comparison, ns=(observation['before']['mtimeNs'], observation['before']['mtimeNs']))
                observation['comparisonBefore'] = retain_index(comparison)
                try:
                    return subprocess.check_output(argv, cwd=cwd, env={**env, 'GIT_INDEX_FILE': str(comparison)})
                finally:
                    observation['comparisonAfter'] = retain_index(comparison)
        return subprocess.check_output(argv, cwd=cwd, env=env)
    finally:
        observation['after'] = retain_index(index)
        index_observations.append(observation)
        save(evidence / 'index-command-observations.json', index_observations)
        assert observation['before']['sha256'] == observation['after']['sha256'], 'Read-only Git command changed real index'



def git_text(*args, cwd=checkout):
    return git(*args, cwd=cwd).decode().strip()



def tracked_snapshot(names):
    rows = {}
    for name in names:
        file = checkout / name
        if file.is_symlink():
            rows[name] = {'kind': 'symlink', 'sha256': sha(os.readlink(file).encode())}
        else:
            assert file.is_file(), 'Missing tracked file: ' + name
            rows[name] = {'kind': 'file', 'sha256': digest(file)}
    return rows



def index_facts():
    index = Path(git_text('rev-parse', '--git-path', 'index'))
    if not index.is_absolute():
        index = checkout / index
    stage = git('ls-files', '--stage', '-z')
    flags = git('ls-files', '-v', '-z')
    assert all(row.startswith(b'H ') for row in flags.split(b'\0') if row), 'Sparse/assume-unchanged flags'
    return {'fileSHA256': digest(index), 'entriesSHA256': sha(stage), 'flagsSHA256': sha(flags)}, stage



def verify_assets():
    assert (assets / 'manifest.json').read_bytes() == manifest_bytes
    for name, expected in manifest['sha256'].items():
        target = proof_root / name
        assert not Path(name).is_absolute() and '..' not in Path(name).parts and not target.is_symlink()
        assert digest(target) == expected, name



def verify_no_checkout_credentials(root):
    check = subprocess.run(['/usr/bin/git', 'config', '--local', '--name-only', '--get-regexp',
                            '(extraheader|credential)'], cwd=root, capture_output=True)
    assert check.returncode == 1 and not check.stdout, 'Checkout retains credential configuration'



def capture_source():
    assert git_text('rev-parse', 'HEAD') == binding['candidateHead']
    assert git_text('rev-parse', 'HEAD^{tree}') == binding['candidateTree']
    assert git_text('remote', 'get-url', 'origin') == 'https://github.com/' + binding['candidateRepository']
    assert not git('diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--')
    assert not git('diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--')
    index, stage = index_facts()
    names = []
    for row in stage.split(b'\0'):
        if not row:
            continue
        metadata, raw_name = row.split(b'\t', 1)
        mode, _, level = metadata.decode().split(' ')
        name = raw_name.decode()
        assert level == '0' and mode in {'100644', '100755', '120000'}
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        names.append(name)
    assert len(names) == len(set(names))
    snapshot = tracked_snapshot(names)
    for name, expected in binding['sourceHashes'].items():
        assert snapshot[name] == {'kind': 'file', 'sha256': expected}, name
    save(evidence / 'tracked-candidate.json', {'index': index, 'tracked': snapshot})
    return {'index': index, 'tracked': snapshot, 'names': names}



def source_guard(label):
    index, _ = index_facts()
    expected = dict(initial_guard['tracked'])
    observed = {'head': git_text('rev-parse', 'HEAD'), 'tree': git_text('rev-parse', 'HEAD^{tree}'),
                'index': index, 'testOverlay': False, 'trackedCount': len(expected)}
    save(evidence / ('source-' + label + '.json'), observed)
    snapshot = tracked_snapshot(initial_guard['names'])
    changes = [name for name in expected if snapshot[name] != expected[name]]
    git_changes = [value.decode() for value in git('diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--').split(b'\0') if value]
    lock = checkout / 'node_modules/.pnpm/lock.yaml'
    current_lock = digest(lock) if lock.is_file() else None
    identity = sha(json.dumps({'head': observed['head'], 'tree': observed['tree'], 'tracked': snapshot}, sort_keys=True, separators=(',', ':')).encode())
    observed.update(changedBytes=changes, gitChangedPaths=git_changes, sourceIdentity=identity,
                    installedLockSHA256=current_lock, indexUnchanged=index == initial_guard['index'])
    save(evidence / ('source-' + label + '.json'), observed)
    assert observed['head'] == binding['candidateHead'] and observed['tree'] == binding['candidateTree']
    assert observed['indexUnchanged'], 'Index changed'
    assert not changes, changes
    assert git_changes == [], git_changes
    if installed_lock is not None:
        assert current_lock == installed_lock, 'Installed frozen lock changed'
    verify_no_checkout_credentials(checkout)
    verify_assets()
    observed['indexAfterComparisons'], _ = index_facts()
    save(evidence / ('source-' + label + '.json'), observed)
    assert observed['indexAfterComparisons'] == initial_guard['index'], 'Index changed during guard'
    return observed



def run(name, argv, env, timeout, diagnostic=False):
    receipt['phase'] = name
    print('PROOF_PHASE:' + name, flush=True)
    result = {'name': name, 'argv': argv, 'exitCode': None, 'termination': None,
              'executionTimeoutSeconds': timeout, 'cleanupReserveSeconds': 60,
              'diagnostic': diagnostic, 'status': 'incomplete'}
    started = time.monotonic()
    child = None
    completed = group_empty = False
    try:
        with (evidence / (name + '.stdout')).open('xb') as out, (evidence / (name + '.stderr')).open('xb') as err:
            child = subprocess.Popen(argv, cwd=checkout, env=env, stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=err, start_new_session=True)
            result['pid'] = result['pgid'] = child.pid
            while child.poll() is None:
                size = (evidence / (name + '.stdout')).stat().st_size + (evidence / (name + '.stderr')).stat().st_size
                if size > MAX_LOG_BYTES or time.monotonic() - started > timeout:
                    result['termination'] = 'output-limit' if size > MAX_LOG_BYTES else 'timeout'
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=60)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=10)
                    break
                time.sleep(0.2)
            result['exitCode'] = child.wait()
        assert result['termination'] is None, name + ' exceeded process limit'
        # Numeric check failure is a result, not evidence of an unjoined process.
        completed = True
    finally:
        result['leaderExitObserved'] = child is not None and child.poll() is not None
        if child is not None and result['leaderExitObserved']:
            deadline = time.monotonic() + 1
            while True:
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    group_empty = True
                    break
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.02)
        result['commandGroupEmpty'] = group_empty
        result['closureScope'] = 'outer command group; nested groups remain owned by unchanged canonical check wrappers'
        if not completed or not group_empty:
            receipt['unconfirmedCommandGroups'].append(name)
        result['status'] = ('passed' if result['exitCode'] == 0 else 'failed') if completed and group_empty else 'incomplete'
        for suffix in ['stdout', 'stderr']:
            log = evidence / (name + '.' + suffix)
            if log.is_file():
                result[suffix] = {'bytes': log.stat().st_size, 'sha256': digest(log)}
        result['seconds'] = round(time.monotonic() - started, 3)
        receipt['commands'].append(result)
        save(evidence / (name + '-result.json'), result)
    assert group_empty, name + ' left its command group active'
    assert sum(result[suffix]['bytes'] for suffix in ['stdout', 'stderr']) <= MAX_LOG_BYTES, name + ' exceeded log bound'
    if not diagnostic:
        assert result['exitCode'] == 0, name + ' failed'
    return result



def runtime_env(label):
    home = scratch / label
    home.mkdir(mode=0o700)
    env = {'PATH': environment_path, 'HOME': str(home), 'CI': 'true', 'GITHUB_ACTIONS': 'true', 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_TERMINAL_PROMPT': '0', 'COREPACK_HOME': str(scratch / 'corepack'), 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'}
    for key, name in [('TMPDIR', 'tmp'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                      ('XDG_DATA_HOME', 'data'), ('OPENCLAW_STATE_DIR', 'state')]:
        directory = home / name
        directory.mkdir(mode=0o700)
        env[key] = str(directory)
    return env



def run_plan_stage(*, checkout, evidence, assets, node, git, run, source_guard, base_env):
    binding = json.loads((assets / "plan-binding.json").read_text())
    assert binding["runnable"] is True and binding["executionMayRun"] is True
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    assert os.environ.get("RUNNER_OS") == "Linux"
    # The parent guard owns Ubuntu 24.04, publisher SHA/assets and full source identity.
    assert git("rev-parse", "HEAD").decode().strip() == binding["mergeHead"]
    assert git("rev-parse", "HEAD^{tree}").decode().strip() == binding["mergeTree"]
    parents = [line[7:] for line in git("cat-file", "commit", "HEAD").decode().split("\n\n", 1)[0].splitlines() if line.startswith("parent ")]
    assert parents == binding["parents"]
    assert git("rev-parse", "--is-shallow-repository").decode().strip() in {"true", "false"}
    # Fetch-depth 2 is setup-owned. Require visible two-parent traversal as well as headers.
    assert git("rev-list", "--parents", "-n", "1", "HEAD").decode().split() == [binding["mergeHead"], *parents]
    assert not git("ls-files", "--others", "-z"), "Source contains untracked/ignored inputs"
    assert not (checkout / "node_modules").exists()

    def digest(data):
        return hashlib.sha256(data).hexdigest()

    def save(name, value):
        (evidence / name).write_text(json.dumps(value, indent=2) + "\n")

    def outputs(name):
        rows = {}
        for line in (evidence / name).read_text().splitlines():
            key, value = line.split("=", 1)
            assert key not in rows, "Duplicate canonical output: " + key
            rows[key] = value
        return rows

    source_bindings = json.loads((assets / "source-bindings.json").read_text())["sourceHashes"]
    for name, expected in source_bindings.items():
        assert digest((checkout / name).read_bytes()) == expected["sha256"], name
    # Reuse the guard's disposable-index technique for candidate-owned Git reads too.
    comparison_index = evidence / "planner.index"
    comparison_index.write_bytes((checkout / ".git/index").read_bytes())
    stamp = (checkout / ".git/index").stat().st_mtime_ns
    os.utime(comparison_index, ns=(stamp, stamp))
    save("planner-index-initial.json", {"sha256": digest(comparison_index.read_bytes()),
         "mtimeNs": stamp, "purpose": "disposable index for canonical planner Git reads"})
    env = {**base_env, **binding["modeledEventEnv"], "GIT_INDEX_FILE": str(comparison_index)}
    assert "OPENCLAW_CI_TEST_TIMINGS" not in env
    assert not any(key in env for key in ["GH_TOKEN", "GITHUB_TOKEN", "CHECKOUT_TOKEN", "ACTIONS_RUNTIME_TOKEN"])
    save("modeled-inputs.json", {"binding": binding, "environmentNames": sorted(env),
        "publisherEventIsSeparate": True, "originalFailedCiCheckoutProven": False})

    def command(name, argv, extra=None):
        try:
            return run(name, argv, {**env, **(extra or {})}, 180)
        finally:
            source_guard(name)

    command("node-version", [node, "--version"])
    assert (evidence / "node-version.stdout").read_text().strip() == "v" + binding["nodeVersion"]
    command("logical-profile", ["/bin/bash", "--noprofile", "--norc", "-c", (assets / "canonical-profile.sh.txt").read_text()],
            {"GITHUB_OUTPUT": str(evidence / "profile-output.txt")})
    profile = outputs("profile-output.txt")
    assert profile == {"hosted_runner_profile_contract": "true", "runner_profile": "github"}
    command("docs-scope", ["/bin/bash", "--noprofile", "--norc", "-c", (assets / "canonical-docs.sh.txt").read_text()],
            {"BASE_SHA": binding["parents"][0], "GITHUB_OUTPUT": str(evidence / "docs-output.txt")})
    docs = outputs("docs-output.txt")
    assert set(docs) == {"docs_only", "docs_changed"}
    assert all(value in {"true", "false"} for value in docs.values())
    # Canonical CI skips changed_scope on docs-only PRs; do not invent a full plan.
    assert docs["docs_only"] == "false", "Docs-only candidate cannot match the requested Node rows"
    command("changed-scope", [node, "scripts/ci-changed-scope.mjs", "--base", binding["parents"][0],
            "--head", "HEAD", "--merge-head-first-parent"], {"GITHUB_OUTPUT": str(evidence / "scope-output.txt")})
    scope = outputs("scope-output.txt")
    changed_paths = json.loads(scope["changed_paths_json"])
    assert isinstance(changed_paths, list) and all(isinstance(path, str) for path in changed_paths)
    exact_paths = [value.strip() for value in git("diff", "--no-renames", "--name-only", binding["parents"][0], "HEAD").decode().splitlines() if value.strip()]
    assert changed_paths == exact_paths, "Canonical scope fell back or changed-path inventory is incomplete"
    save("scope.json", {"docs": docs, "scope": scope, "logicalProfile": profile})

    # Match the canonical same-revision harness imports with exactly four byte-bound files.
    # No source/test overlays, Git checkout/index mutation, symlinks or dependency install.
    harness = checkout / ".ci-harness"
    assert not harness.exists() and not harness.is_symlink()
    receipt["planHarnessOwned"] = True
    harness_names = binding["harnessFiles"]
    for name in harness_names:
        target = harness / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((checkout / name).read_bytes())
    try:
        manifest_env = {"OPENCLAW_CI_" + key.upper(): scope[key] for key in binding["scopeToManifestKeys"]}
        manifest_env.update(binding["manifestEnv"])
        manifest_env.update(OPENCLAW_CI_DOCS_ONLY=docs["docs_only"], OPENCLAW_CI_DOCS_CHANGED=docs["docs_changed"],
            OPENCLAW_CI_CHANGED_PATHS_JSON=scope["changed_paths_json"], OPENCLAW_CI_RUNNER_PROFILE=profile["runner_profile"],
            GITHUB_OUTPUT=str(evidence / "manifest-output.txt"),
            PLAN_DESCRIPTOR_REPORT=str(evidence / "all-descriptors.json"),
            PLAN_FINAL_REPORT=str(evidence / "plan-report.json"),
            PLAN_REQUESTED_NAMES=json.dumps(binding["requestedCheckNames"]))
        program = (assets / "canonical-manifest.mjs.txt").read_text()
        marker = "const nodeTestNonDistShards = nodeTestShards.filter((shard) => !shard.requires_dist);"
        assert program.count(marker) == 1
        program = program.replace(marker, (assets / "report-before-admission.mjs.txt").read_text() + "\n" + marker)
        program += "\n" + (assets / "report-after-manifest.mjs.txt").read_text()
        (evidence / "observed-manifest-program.mjs.txt").write_text(program)
        save("manifest-environment.json", manifest_env)
        command("canonical-plan", [node, "--input-type=module", "--eval", program], manifest_env)
        report = json.loads((evidence / "plan-report.json").read_text())
        assert report["passed"] is True and report["unmatched"] == []
        assert [row["name"] for row in report["requested"]] == binding["requestedCheckNames"]
        assert all(row["matchCount"] == 1 for row in report["requested"])
        return report
    finally:
        expected_untracked = {".ci-harness/" + name for name in harness_names}
        observed_untracked = {value.decode() for value in git("ls-files", "--others", "-z").split(b"\0") if value}
        assert observed_untracked == expected_untracked, "Unexpected planner filesystem input/output"
        for name in harness_names:
            assert digest((harness / name).read_bytes()) == source_bindings[name]["sha256"]
        source_guard("plan-final")
        # Parent cleanup owns scratch/harness removal only after command-group closure.
        save("plan-harness.json", {"files": harness_names, "bytesUnchanged": True,
             "cleanupOwner": "reviewed outer controller", "testsExecuted": False})


def verify_fragments():
    workflow = (checkout / '.github/workflows/ci.yml').read_text()
    start = '          node "${manifest_node_args[@]}" --input-type=module <<\'EOF\'\n'
    assert workflow.count(start) == 1
    manifest_body = workflow.split(start, 1)[1].split('          EOF\n', 1)[0]
    profile_start = '      - name: Resolve logical runner profile\n'
    assert workflow.count(profile_start) == 1
    profile_body = workflow.split(profile_start, 1)[1].split('      - name: Resolve exact diff base\n', 1)[0].split('        run: |\n', 1)[1]
    docs_body = (checkout / '.github/actions/detect-docs-changes/action.yml').read_text().split('      run: |\n', 1)[1]
    for name, body, indent in [
        ('canonical-manifest.mjs.txt', manifest_body, 10),
        ('canonical-profile.sh.txt', profile_body, 10),
        ('canonical-docs.sh.txt', docs_body, 8),
    ]:
        lines = body.splitlines()
        assert all(not line or line.startswith(' ' * indent) for line in lines)
        extracted = '\n'.join(line[indent:] if line else '' for line in lines) + '\n'
        assert (assets / name).read_text() == extracted, name + ': canonical source extraction differs'
    save(evidence / 'canonical-fragments.json', {
        name: digest(assets / name) for name in binding['canonicalFragments']
    })


def lock_guard(label):
    facts = {
        'pnpmLockSHA256': digest(checkout / 'pnpm-lock.yaml'),
        'workspaceSHA256': digest(checkout / 'pnpm-workspace.yaml'),
        'nodeModulesPresent': os.path.lexists(checkout / 'node_modules'),
        'installPerformed': False,
    }
    save(evidence / ('lock-' + label + '.json'), facts)
    assert facts['pnpmLockSHA256'] == binding['sourceHashes']['pnpm-lock.yaml']
    assert facts['workspaceSHA256'] == binding['sourceHashes']['pnpm-workspace.yaml']
    assert facts['nodeModulesPresent'] is False, 'Plan-only source acquired a dependency tree'


def cleanup_plan_harness():
    harness = checkout / '.ci-harness'
    assert not harness.is_symlink()
    if not receipt.get('planHarnessOwned'):
        assert not harness.exists(), 'An unowned harness must be retained'
        return
    allowed = set(binding['harnessFiles'])
    actual = set()
    directories = set()
    if harness.exists():
        assert harness.is_dir()
        for file in harness.rglob('*'):
            assert not file.is_symlink(), 'Harness symlink must be retained'
            name = str(file.relative_to(harness))
            if file.is_dir():
                directories.add(name)
            else:
                assert file.is_file() and name in allowed, 'Unexpected harness output must be retained'
                assert digest(file) == binding['sourceHashes'][name], 'Changed harness bytes must be retained'
                actual.add(name)
        allowed_directories = {str(parent) for name in allowed for parent in Path(name).parents if str(parent) != '.'}
        assert directories.issubset(allowed_directories), 'Unexpected harness directory must be retained'
        shutil.rmtree(harness)
    assert not harness.exists()
    save(evidence / 'harness-cleanup.json', {'removedFiles': sorted(actual), 'removed': True,
         'partialSetup': actual != allowed, 'unexpectedPathsRemoved': False})


try:
    assert binding['runnable'] is True and binding['executionMayRun'] is True, 'Plan proposal is disabled'
    assert platform.system() == 'Linux' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('RUNNER_OS') == 'Linux'
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    assert os_release.get('ID', '').strip(chr(34)) == 'ubuntu'
    assert os_release.get('VERSION_ID', '').strip(chr(34)) == '24.04'
    assert os.environ.get('GITHUB_REPOSITORY') == binding['publisherRepository'] == 'steipete/openclaw'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/' + binding['publisherBranch']
    assert os.environ.get('GITHUB_EVENT_NAME') in {'push', 'workflow_dispatch'}
    assert checkout.name == 'source'
    assert binding['candidateHead'] == binding['mergeHead'] == '3ba6a62a352ea58d5999a9ed4c04b9de9479377f'
    assert binding['candidateTree'] == binding['mergeTree'] == '842c018ecd7e8141cbe6e27e238698539413899b'
    assert binding['candidateRepository'] == binding['mergeRepository'] == 'openclaw/openclaw'
    assert binding['parents'] == ['5aaafb76c427d383e5eefc8a6934f895dd82880e', '876101775afc88f7df842795219177f1594baceb']
    assert binding['originalFailedCiCheckoutProven'] is False
    assert binding['originalFailedCiWorkflowRevisionProven'] is False
    assert binding['nodeVersion'] == '24.19.0'
    manifest_bytes = (assets / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest['incomplete'] is False
    assert git_text('rev-parse', 'HEAD', cwd=proof_root) == os.environ['GITHUB_SHA']
    verify_no_checkout_credentials(proof_root)
    verify_no_checkout_credentials(checkout)
    verify_assets()
    source_bindings = json.loads((assets / 'source-bindings.json').read_text())
    assert source_bindings['head'] == binding['candidateHead'] and source_bindings['tree'] == binding['candidateTree']
    assert {name: row['sha256'] for name, row in source_bindings['sourceHashes'].items()} == binding['sourceHashes']
    assert all(re.fullmatch(r'[a-f0-9]{64}', value) for value in binding['sourceHashes'].values())
    initial_guard = capture_source()
    assert not git('ls-files', '--others', '-z'), 'Initial source is not a complete clean checkout'
    lock_guard('initial')
    verify_fragments()
    parents = [line[7:] for line in git('cat-file', 'commit', 'HEAD').split(b'\n\n', 1)[0].decode().splitlines() if line.startswith('parent ')]
    assert parents == binding['parents']
    assert git_text('rev-list', '--parents', '-n', '1', 'HEAD').split() == [binding['candidateHead'], *parents]
    assert git_text('rev-parse', parents[0] + '^{commit}') == parents[0]
    save(evidence / 'commit-provenance.json', {'head': binding['candidateHead'], 'tree': binding['candidateTree'],
         'parents': parents, 'capturedMergeTimestamp': binding['capturedMergeTimestamp'],
         'originalFailedCiCheckoutProven': False, 'originalFailedCiWorkflowRevisionProven': False})
    node = str(Path(shutil.which('node')).resolve())
    assert Path(node).is_file()
    scratch = Path(tempfile.mkdtemp(prefix='p126547-plan-', dir='/tmp')).resolve()
    (scratch / 'corepack').mkdir(mode=0o700)
    environment_path = str(Path(node).parent) + ':/usr/bin:/bin'
    plan_env = runtime_env('plan')
    provenance = {key: os.environ[key] for key in ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
                  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH']}
    save(evidence / 'hosted-source.json', {'binding': binding, 'hostedProvenance': provenance,
         'nodeExecutableSHA256': digest(node), 'manifestSHA256': digest(assets / 'manifest.json'),
         'runtimeEnvNames': sorted(plan_env), 'testsExecuted': False})
    save(evidence / 'hosted-platform.json', {'osRelease': os_release, 'machine': platform.machine(),
         'logicalCpuCount': os.cpu_count(), 'physicalMemoryBytes': os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')})
    save(evidence / 'git-toolchain.json', {'version': git_text('--version'), 'executableSHA256': digest('/usr/bin/git'),
         'optionalLocks': '0', 'porcelainDiffIndex': 'disposable copy with original index mtime; real index guarded'})
    report = run_plan_stage(checkout=checkout, evidence=evidence, assets=assets, node=node,
                           git=git, run=run, source_guard=source_guard, base_env=plan_env)
    assert [row['name'] for row in receipt['commands']] == binding['expectedCommandNames']
    assert all(row['status'] == 'passed' for row in receipt['commands'])
    receipt.update(passed=report['passed'], phase='complete', requestedMatches=report['requested'],
                   allPlanCommandsExecuted=True)
except Exception as error:
    receipt['error'] = str(error)
    (evidence / 'failure.txt').write_text(traceback.format_exc())
finally:
    try:
        planner_index = evidence / 'planner.index'
        if planner_index.exists():
            assert not planner_index.is_symlink() and planner_index.is_file()
            assert planner_index.stat().st_size <= 8 * 1024 * 1024
            save(evidence / 'planner-index-final.json', {'sha256': digest(planner_index),
                 'mtimeNs': planner_index.stat().st_mtime_ns, 'realIndexGuardedSeparately': True})
        if initial_guard is not None:
            source_guard('before-cleanup')
            lock_guard('before-cleanup')
        assert not receipt['unconfirmedCommandGroups'], 'Command closure unconfirmed; retain private runtime'
        if initial_guard is not None:
            cleanup_plan_harness()
            assert not git('ls-files', '--others', '-z'), 'Unexpected planner output must be retained'
            source_guard('final')
            lock_guard('final')
        if scratch is not None:
            shutil.rmtree(scratch)
            assert not scratch.exists()
        receipt.update(ownedScratchRemoved=True, privateRuntimeRetained=False)
    except Exception as error:
        receipt.update(ownedScratchRemoved=False, privateRuntimeRetained=scratch is not None, passed=False)
        receipt['cleanupErrors'].append(str(error))
    save(evidence / 'cleanup.json', {'ownedScratchRemoved': receipt.get('ownedScratchRemoved', False),
         'privateRuntimeRetained': receipt.get('privateRuntimeRetained', False),
         'unconfirmedCommandGroups': receipt['unconfirmedCommandGroups'], 'errors': receipt['cleanupErrors']})
    receipt['notExecutedCommands'] = [name for name in binding['expectedCommandNames']
                                      if not any(row['name'] == name for row in receipt['commands'])]
    try:
        files = [file for file in evidence.rglob('*') if file.is_file()]
        assert all(not file.is_symlink() and file.stat().st_size <= MAX_LOG_BYTES for file in files)
        assert sum(file.stat().st_size for file in files) <= 64 * 1024 * 1024
        save(evidence / 'artifact-manifest.json', {str(file.relative_to(evidence)): digest(file) for file in files})
    except Exception as error:
        receipt['cleanupErrors'].append(str(error))
        receipt['passed'] = False
    save(evidence / 'hosted-proof-result.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['passed', 'phase', 'planOnly', 'testsExecuted']}))
sys.exit(0 if receipt['passed'] else 1)
