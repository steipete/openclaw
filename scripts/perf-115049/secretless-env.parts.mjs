// Inert environment builder; the final reviewed workflow owns the fresh root and child launch.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function createSnapshotProofEnvironment(ownedRoot) {
  assert.equal(process.env.CI, "true", "snapshot runtime proof is restricted to secretless CI");
  assert.ok(path.isAbsolute(ownedRoot));
  const homeDir = path.join(ownedRoot, "home");
  const stateDir = path.join(ownedRoot, "state");
  const tempDir = path.join(ownedRoot, "tmp");
  const xdgConfigDir = path.join(ownedRoot, "xdg-config");
  const xdgDataDir = path.join(ownedRoot, "xdg-data");
  const xdgCacheDir = path.join(ownedRoot, "xdg-cache");
  const codexDir = path.join(ownedRoot, "codex");
  for (const directory of [
    homeDir,
    stateDir,
    tempDir,
    xdgConfigDir,
    xdgDataDir,
    xdgCacheDir,
    codexDir,
  ]) {
    // A reused populated root could carry credentials or prior plugin state.
    await fs.mkdir(directory, { mode: 0o700 });
  }
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "true",
    HOME: homeDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    XDG_CONFIG_HOME: xdgConfigDir,
    XDG_DATA_HOME: xdgDataDir,
    XDG_CACHE_HOME: xdgCacheDir,
    CODEX_HOME: codexDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(ownedRoot, "openclaw.json"),
    OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
  };
}
