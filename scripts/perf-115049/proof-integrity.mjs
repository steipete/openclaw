// Task proof source binding; no product imports occur before exact checkout verification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PINS = {
  baseline: {
    commit: "5f661669b2c2979f2a61e23d4addb3bdd4545469",
    tree: "edf08c934a1a371e06128814106ae325600d3b57",
  },
  candidate: {
    commit: "94ce6288f3606ef2f5d47b5680458c1f434d8009",
    tree: "b28b7f6269b70f1988c52a0266ccc4eaf6445fdf",
  },
};
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1" },
  });
export async function verifySource(repo, variant, overlays = {}) {
  const pin = PINS[variant];
  assert.ok(pin);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), pin.commit);
  assert.equal(git(repo, ["rev-parse", "HEAD^{tree}"]).trim(), pin.tree);
  const entries = git(repo, ["ls-tree", "-rz", "--full-tree", pin.commit])
    .split("\0")
    .filter(Boolean);
  const manifest = {};
  for (const entry of entries) {
    const [, mode, type, oid, file] = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(entry) ?? [];
    assert.equal(type, "blob", "proof source must contain only ordinary tracked blobs");
    const target = path.join(repo, file);
    const stat = await fs.lstat(target);
    const bytes =
      mode === "120000" ? Buffer.from(await fs.readlink(target)) : await fs.readFile(target);
    assert.equal(stat.isSymbolicLink(), mode === "120000", file);
    if (mode !== "120000") {
      assert.ok(stat.isFile(), file);
      assert.equal(Boolean(stat.mode & 0o111), mode === "100755", file);
    }
    assert.equal(
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      overlays[file] ?? oid,
      file,
    );
    manifest[file] = { mode, sha256: digest(bytes) };
  }
  for (const file of Object.keys(overlays)) {
    assert.ok(manifest[file], "overlay must replace one tracked source file");
  }
  return { ...pin, files: manifest, sha256: digest(JSON.stringify(manifest)) };
}
export function blobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
export async function runtimeManifest(repo) {
  const files = {};
  async function walk(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(repo, file);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        await walk(file);
      } else if (stat.isSymbolicLink()) {
        files[relative] = { link: await fs.readlink(file) };
      } else {
        assert.ok(stat.isFile(), relative);
        files[relative] = {
          sha256: digest(await fs.readFile(file)),
          executable: Boolean(stat.mode & 0o111),
        };
      }
    }
  }
  await walk(path.join(repo, "dist"));
  const store = path.join(repo, "node_modules/.pnpm");
  const nativePackages = (await fs.readdir(store)).filter((name) =>
    name.startsWith("@openai+codex@0.153.4"),
  );
  assert.ok(
    nativePackages.some((name) => name.startsWith("@openai+codex@0.153.4-linux-x64")),
    "the pinned native Linux Codex package must be installed",
  );
  for (const name of nativePackages.sort()) {
    await walk(path.join(store, name));
  }
  assert.ok(Object.keys(files).length > 0);
  return { files, sha256: digest(JSON.stringify(files)) };
}
export async function verifyBuilt(repo, variant, expected) {
  const source = await verifySource(repo, variant);
  const runtime = await runtimeManifest(repo);
  for (const [name, field] of [
    [".buildstamp", "head"],
    [".runtime-postbuildstamp", "head"],
    ["build-info.json", "commit"],
  ]) {
    const stamp = JSON.parse(await fs.readFile(path.join(repo, "dist", name), "utf8"));
    assert.equal(stamp[field], source.commit);
  }
  const actual = { source, runtime };
  if (expected) {
    assert.deepEqual(actual, expected, "source/runtime/stamp bytes changed during the proof");
  }
  return actual;
}
