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
 * This script tars up the runtime-staged channel extension tree (with
 * symlinks dereferenced so node_modules ships its real contents) into
 * channels.tar.gz. The sandbox bootstrap downloads + extracts this
 * next to the bundle, then sets OPENCLAW_BUNDLED_PLUGINS_DIR so the bundle's
 * plugin discovery code finds each plugin's package.json on disk.
 *
 * Selection: any extension under dist-runtime/extensions/ whose package.json
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
const CHUNKS_OUT_FILE = path.join(OUT_DIR, "channel-shared-chunks.tar.gz");

const log = (...parts) => process.stderr.write(parts.join(" ") + "\n");

async function listDistSharedChunkFiles() {
  const distRoot = path.dirname(SRC_DIR);
  const entries = await readdir(distRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .toSorted();
}

async function listChannelExtensions() {
  let entries;
  try {
    entries = await readdir(SRC_DIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `missing ${SRC_DIR} — run \`pnpm build\` first to populate dist-runtime/extensions (err: ${err?.message || err})`,
      { cause: err },
    );
  }
  const channels = [];
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
    if (pkg?.openclaw?.channel) {
      channels.push(entry.name);
    }
  }
  channels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return channels;
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
  const channels = await listChannelExtensions();
  if (channels.length === 0) {
    throw new Error(
      `no channel extensions found in ${SRC_DIR} — verify pnpm build populated openclaw.channel package.json fields`,
    );
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
  if (distChunkFiles.length > 0) {
    await runTar(["-czhf", CHUNKS_OUT_FILE, ...distChunkFiles], path.dirname(SRC_DIR));
  }
  const outStat = await stat(OUT_FILE);
  log(`\narchive: ${path.relative(REPO_ROOT, OUT_FILE)}`);
  log(`  size: ${(outStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log(`  channels: ${channels.length}`);
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
