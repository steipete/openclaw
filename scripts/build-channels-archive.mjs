#!/usr/bin/env node
/**
 * Channels archive builder for the sandbox bundle deployment.
 *
 * The single-file ESM bundle (build-bundle-esm.mjs) ships the gateway core
 * but no plugins — esbuild only traces static imports from dist/entry.js,
 * and channel plugins are discovered at runtime from the extensions tree.
 * In bundle mode that tree doesn't exist, so the gateway boots with zero
 * plugins and channel webhooks 404.
 *
 * This script tars up the runtime-staged extension tree (with symlinks
 * dereferenced so node_modules ships its real contents). Channels are
 * auto-discovered into channels.tar.gz. Explicit non-channel plugins from the
 * bundle profile are packaged separately in runtime-plugins.tar.gz.
 *
 * Selection: any extension under dist/extensions/ whose package.json
 * declares an `openclaw.channel` field is included. Run `pnpm build` first.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
// Source from dist/extensions, not dist-runtime/extensions: the latter only
// contains 4-line wrapper stubs that re-export from `../../../dist/extensions/<name>/`.
// That relative path leaks the dev tree layout — when extracted into the
// sandbox's `extensions/` directory, the wrappers fail with
// `Cannot find module '../../../dist/extensions/<name>/index.js'`.
// dist/extensions/ holds the real compiled output plus the dependency
// node_modules tree (deduped under each extension via symlink).
const SRC_DIR = path.join(REPO_ROOT, "dist", "extensions");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const OUT_FILE = path.join(OUT_DIR, "channels.tar.gz");
const RUNTIME_PLUGINS_OUT_FILE = path.join(OUT_DIR, "runtime-plugins.tar.gz");
const CHUNKS_OUT_FILE = path.join(OUT_DIR, "channel-shared-chunks.tar.gz");
const PROFILE_NAME = process.env.OPENCLAW_BUNDLE_PROFILE ?? "sandbox";
const PROFILE_PATH = path.join(REPO_ROOT, ".fork", `bundle-profile.${PROFILE_NAME}.json`);

const log = (...parts) => process.stderr.write(parts.join(" ") + "\n");

async function listDistSharedChunkFiles() {
  const distRoot = path.dirname(SRC_DIR);
  const entries = await readdir(distRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .toSorted();
}

async function listBuiltExtensions() {
  let entries;
  try {
    entries = await readdir(SRC_DIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `missing ${SRC_DIR} — run \`pnpm build\` first to populate dist/extensions (err: ${err?.message || err})`,
      { cause: err },
    );
  }
  const extensions = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgPath = path.join(SRC_DIR, entry.name, "package.json");
    let pkg;
    try {
      const raw = await readFile(pkgPath, "utf8");
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    extensions.set(entry.name, pkg);
  }
  return extensions;
}

async function loadBundleProfile() {
  const profile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
  if (profile.profile !== PROFILE_NAME) {
    throw new Error(
      `bundle profile manifest mismatch: expected ${PROFILE_NAME}, got ${JSON.stringify(profile.profile)}`,
    );
  }
  if (
    !Array.isArray(profile.runtimePluginIds) ||
    profile.runtimePluginIds.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new Error(`bundle profile ${PROFILE_NAME} has invalid runtimePluginIds`);
  }
  if (
    !Array.isArray(profile.externalPlugins) ||
    profile.externalPlugins.some(
      (plugin) =>
        !plugin ||
        typeof plugin !== "object" ||
        typeof plugin.id !== "string" ||
        !plugin.id ||
        typeof plugin.packageName !== "string" ||
        !plugin.packageName,
    )
  ) {
    throw new Error(`bundle profile ${PROFILE_NAME} has invalid externalPlugins`);
  }
  return profile;
}

function selectExtensionIds(extensions, profile) {
  const externalPluginIds = new Set(profile.externalPlugins.map((plugin) => plugin.id));
  const channels = [...extensions]
    .filter(([id, pkg]) => Boolean(pkg?.openclaw?.channel) && !externalPluginIds.has(id))
    .map(([id]) => id)
    .toSorted((left, right) => left.localeCompare(right));
  const runtimePlugins = [...new Set(profile.runtimePluginIds)].toSorted((left, right) =>
    left.localeCompare(right),
  );
  for (const id of runtimePlugins) {
    const pkg = extensions.get(id);
    if (!pkg) {
      throw new Error(
        `bundle profile ${PROFILE_NAME} requires missing runtime plugin ${id}; rebase the fork onto an OpenClaw revision that builds it`,
      );
    }
    if (pkg?.openclaw?.channel) {
      throw new Error(
        `bundle profile ${PROFILE_NAME} runtimePluginIds contains channel plugin ${id}; channels are discovered automatically`,
      );
    }
  }
  return { channels, runtimePlugins };
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = await loadBundleProfile();
  const extensions = await listBuiltExtensions();
  const { channels, runtimePlugins } = selectExtensionIds(extensions, profile);
  if (channels.length === 0) {
    throw new Error(
      `no channel extensions found in ${SRC_DIR} — verify pnpm build populated openclaw.channel package.json fields`,
    );
  }
  if (runtimePlugins.length === 0) {
    throw new Error(`bundle profile ${PROFILE_NAME} has no runtimePluginIds`);
  }
  const distChunkFiles = await listDistSharedChunkFiles();
  log(`found ${channels.length} channel extensions: ${channels.join(", ")}`);
  if (distChunkFiles.length > 0) {
    log(`found ${distChunkFiles.length} shared dist chunks for channel runtime imports`);
  }
  // Use -h / --dereference: node_modules under each ext is a symlink to
  // dist/extensions/<name>/node_modules; we need the real contents in the
  // archive, not dangling symlinks pointing into the source tree.
  await runTar(["-czhf", OUT_FILE, ...channels], SRC_DIR);
  await runTar(["-czhf", RUNTIME_PLUGINS_OUT_FILE, ...runtimePlugins], SRC_DIR);
  if (distChunkFiles.length > 0) {
    await runTar(["-czhf", CHUNKS_OUT_FILE, ...distChunkFiles], path.dirname(SRC_DIR));
  }
  const outStat = await stat(OUT_FILE);
  log(`\narchive: ${path.relative(REPO_ROOT, OUT_FILE)}`);
  log(`  size: ${(outStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log(`  channels: ${channels.length}`);
  const runtimePluginsStat = await stat(RUNTIME_PLUGINS_OUT_FILE);
  log(`\nruntime plugins: ${path.relative(REPO_ROOT, RUNTIME_PLUGINS_OUT_FILE)}`);
  log(`  size: ${(runtimePluginsStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log(`  plugins: ${runtimePlugins.join(", ")}`);
  if (distChunkFiles.length > 0) {
    const chunksStat = await stat(CHUNKS_OUT_FILE);
    log(`\nshared chunks: ${path.relative(REPO_ROOT, CHUNKS_OUT_FILE)}`);
    log(`  size: ${(chunksStat.size / (1024 * 1024)).toFixed(2)} MB`);
    log(`  chunks: ${distChunkFiles.length}`);
  }
  log("done.");
};

main().catch((err) => {
  process.stderr.write(`build-channels-archive: ${err?.stack || err}\n`);
  process.exit(1);
});
