#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox", "release-assets");

function parseArgs(argv) {
  const args = {
    tag: process.env.INPUT_TAG || process.env.GITHUB_REF_NAME,
    assetDir: process.env.OPENCLAW_SANDBOX_BUNDLE_ASSET_DIR,
    clobber: process.env.OPENCLAW_GITHUB_RELEASE_CLOBBER === "1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") {
      args.tag = argv[++i];
      continue;
    }
    if (arg === "--asset-dir") {
      args.assetDir = argv[++i];
      continue;
    }
    if (arg === "--clobber") {
      args.clobber = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: publish-github-release-assets --tag <tag> [--asset-dir <dir>] [--clobber]",
      );
      process.exit(0);
    }
    throw new Error("unknown argument: " + arg);
  }
  if (!args.tag) {
    throw new Error("missing release tag; pass --tag or set INPUT_TAG/GITHUB_REF_NAME");
  }
  return { ...args, assetDir: path.resolve(args.assetDir ?? DEFAULT_ASSET_DIR) };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(command + " " + args.join(" ") + " exited with " + (code ?? signal)));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const assetDirInfo = await stat(args.assetDir).catch(() => null);
  if (!assetDirInfo?.isDirectory()) {
    throw new Error("release asset dir does not exist: " + path.relative(REPO_ROOT, args.assetDir));
  }
  const files = (await readdir(args.assetDir))
    .filter((entry) => !entry.startsWith("."))
    .toSorted((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error("release asset dir is empty: " + path.relative(REPO_ROOT, args.assetDir));
  }
  await run("gh", ["release", "view", args.tag, "--json", "isDraft,assets"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  await run(
    "gh",
    [
      "release",
      "upload",
      args.tag,
      ...files.map((file) => path.join(args.assetDir, file)),
      ...(args.clobber ? ["--clobber"] : []),
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  console.log(
    JSON.stringify({
      ok: true,
      tag: args.tag,
      assetDir: path.relative(REPO_ROOT, args.assetDir),
      files,
    }),
  );
}

main().catch((err) => {
  process.stderr.write("publish-github-release-assets: " + (err?.stack || err) + "\n");
  process.exit(1);
});
