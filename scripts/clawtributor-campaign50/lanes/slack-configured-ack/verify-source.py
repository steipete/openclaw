import hashlib
import json
import pathlib
import subprocess
import sys

lane = pathlib.Path(sys.argv[1]).resolve()
phase = sys.argv[2]
assert phase in {"clean", "baseline", "candidate"}
source = json.loads((lane / "source.json").read_text())
manifest = json.loads((lane / "MANIFEST.json").read_text())

def run(*args):
    return subprocess.check_output(args, text=True).strip()

for name, expected in manifest["files"].items():
    assert hashlib.sha256((lane / name).read_bytes()).hexdigest() == expected, name
assert run("git", "rev-parse", "HEAD") == source["base"]
assert run("node", "--version") == "v" + source["node"]
assert run("pnpm", "--version") == source["pnpm"]
subprocess.run(["git", "diff", "--quiet"], check=True)
assert json.loads(pathlib.Path("package.json").read_text())["packageManager"] == source["packageManager"]
sdk_manifest = pathlib.Path(run("node", "-p", "require.resolve('@slack/web-api/package.json', {paths: [process.cwd() + '/extensions/slack']})"))
assert json.loads(sdk_manifest.read_text())["version"] == source["sdkVersion"]
sdk_hashes = {}
for name, expected in source["sdkFiles"].items():
    path = sdk_manifest.parent / "dist" / ("types/request/" + name if name.endswith(".d.ts") else name)
    sdk_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert sdk_hashes[name] == expected, name
expected_files = dict(source["baseline"])
changed = []
if phase != "clean":
    expected_files[source["unit_path"]] = source["candidate"][source["unit_path"]]
    changed.append(source["unit_path"])
if phase == "candidate":
    expected_files.update(source["candidate"])
    changed = sorted(source["candidate"])
assert run("git", "diff", "HEAD", "--name-only").splitlines() == sorted(changed)
for name, expected in expected_files.items():
    assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected, name
untracked = run("git", "ls-files", "--others", "--exclude-standard").splitlines()
assert untracked == ([] if phase == "clean" else [source["test_path"]]), untracked
if phase != "clean":
    assert pathlib.Path(source["test_path"]).read_bytes() == (lane / "ack-ingress.proof.test.ts").read_bytes()
print(json.dumps({"phase": phase, "head": source["base"], "files": expected_files, "node": source["node"], "packageManager": source["packageManager"], "sdk": sdk_hashes}, indent=2))
