#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox", "release-assets");
const FALLBACK_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const WALL_CLOCK_MS = 60_000;
const REQUIRED_PLUGIN_IDS = ["slack"];
const FORBIDDEN_OUTPUT = [
  "Unable to resolve bundled plugin public surface",
  "Cannot find module",
  "ERR_MODULE_NOT_FOUND",
  "npm install",
  "pnpm install",
  "yarn install",
  "corepack",
  "imported again after being required",
  "Status = 0",
];

function parseArgs(argv) {
  const args = { assetDir: process.env.OPENCLAW_SANDBOX_BUNDLE_ASSET_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asset-dir") {
      args.assetDir = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: smoke-sandbox-bundle-local [--asset-dir <dir>]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function exists(filePath) {
  return Boolean(await stat(filePath).catch(() => null));
}

async function resolveAssetDir(explicitAssetDir) {
  if (explicitAssetDir) {
    return path.resolve(explicitAssetDir);
  }
  if (await exists(DEFAULT_ASSET_DIR)) {
    return DEFAULT_ASSET_DIR;
  }
  return FALLBACK_ASSET_DIR;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? signal}`));
      }
    });
  });
}

async function extractTarball(fileName, cwd, targetDir = cwd) {
  await mkdir(targetDir, { recursive: true });
  await run("tar", ["-xzf", path.resolve(cwd, fileName)], {
    cwd: targetDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function findReleaseTar(assetDir) {
  const entries = await readdir(assetDir).catch(() => []);
  const versioned = entries.find((entry) =>
    /^openclaw-sandbox-bundle-v.+-[0-9a-f]{7}\.tar\.gz$/u.test(entry),
  );
  return (
    versioned ?? (entries.includes("openclaw-release.tar.gz") ? "openclaw-release.tar.gz" : null)
  );
}

function parsePrefixedJsonLine(output, prefix) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    const payload = line.slice(prefix.length);
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return null;
}

function parseSmokeLine(output) {
  const parsed = parsePrefixedJsonLine(output, "[bundle-smoke] ");
  return parsed?.ok === true ? parsed : null;
}

function runBundle(cwd, homeDir, extensionsDir, extraEnv = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let output = "";
    let settled = false;
    const child = spawn(process.execPath, ["openclaw.bundle.mjs"], {
      cwd,
      env: {
        HOME: homeDir,
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        OPENCLAW_BUNDLE_PROFILE: "sandbox",
        ...(options.bundleSmoke === false ? {} : { OPENCLAW_BUNDLE_SMOKE: "1" }),
        OPENCLAW_PLUGIN_LOAD_PROFILE: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: extensionsDir,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`bundle smoke exceeded ${WALL_CLOCK_MS}ms wall clock`));
    }, WALL_CLOCK_MS);
    const collect = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code,
        signal,
        output,
        elapsedMs: Math.round(performance.now() - start),
      });
    });
  });
}

async function copyAsset(assetDir, tmpRoot, fileName) {
  const source = path.join(assetDir, fileName);
  if (!(await exists(source))) {
    throw new Error(`missing required release asset: ${path.relative(REPO_ROOT, source)}`);
  }
  await copyFile(source, path.join(tmpRoot, fileName));
}

async function requireStagedAsset(tmpRoot, fileName, releaseTar) {
  if (!(await exists(path.join(tmpRoot, fileName)))) {
    throw new Error(`release tarball ${releaseTar} is missing required sidecar: ${fileName}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const assetDir = await resolveAssetDir(args.assetDir);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-bundle-smoke-"));
  try {
    const homeDir = path.join(tmpRoot, "home");
    const extensionsDir = path.join(tmpRoot, "extensions");
    await mkdir(homeDir, { recursive: true });

    const releaseTar = await findReleaseTar(assetDir);
    if (releaseTar) {
      await copyAsset(assetDir, tmpRoot, releaseTar);
      await extractTarball(releaseTar, tmpRoot);
    } else {
      await copyAsset(assetDir, tmpRoot, "openclaw.bundle.mjs");
    }

    for (const sidecar of ["bundle-deps.tar.gz", "bundle-openclaw-pkg.tar.gz", "channels.tar.gz"]) {
      if (releaseTar) {
        await requireStagedAsset(tmpRoot, sidecar, releaseTar);
      } else if (!(await exists(path.join(tmpRoot, sidecar)))) {
        await copyAsset(assetDir, tmpRoot, sidecar);
      }
    }
    await extractTarball("bundle-deps.tar.gz", tmpRoot);
    await extractTarball("bundle-openclaw-pkg.tar.gz", tmpRoot);
    await extractTarball("channels.tar.gz", tmpRoot, extensionsDir);

    if (
      !releaseTar &&
      !(await exists(path.join(tmpRoot, "channel-shared-chunks.tar.gz"))) &&
      (await exists(path.join(assetDir, "channel-shared-chunks.tar.gz")))
    ) {
      await copyAsset(assetDir, tmpRoot, "channel-shared-chunks.tar.gz");
    }
    if (await exists(path.join(tmpRoot, "channel-shared-chunks.tar.gz"))) {
      await extractTarball("channel-shared-chunks.tar.gz", tmpRoot);
    }

    const contract = JSON.parse(await readFile(path.join(tmpRoot, "bundle-contract.json"), "utf8"));
    const disabledPublicSurfaces = Array.isArray(contract.disabledPublicSurfaces)
      ? contract.disabledPublicSurfaces
      : [];
    let publicSurfaceSmoke = null;
    if (disabledPublicSurfaces.length > 0) {
      const publicSurfaceResult = await runBundle(
        tmpRoot,
        homeDir,
        extensionsDir,
        {
          OPENCLAW_BUNDLE_PUBLIC_SURFACE_SMOKE: JSON.stringify(disabledPublicSurfaces),
        },
        { bundleSmoke: false },
      );
      const publicSurfaceForbiddenHit = FORBIDDEN_OUTPUT.find((needle) =>
        publicSurfaceResult.output.includes(needle),
      );
      if (publicSurfaceForbiddenHit) {
        throw new Error(
          `bundle public-surface smoke output contained forbidden text: ${publicSurfaceForbiddenHit}\n${publicSurfaceResult.output}`,
        );
      }
      if (publicSurfaceResult.code !== 0) {
        throw new Error(
          `bundle public-surface smoke exited nonzero: ${publicSurfaceResult.code ?? publicSurfaceResult.signal}\n${publicSurfaceResult.output}`,
        );
      }
      publicSurfaceSmoke = parsePrefixedJsonLine(
        publicSurfaceResult.output,
        "[bundle-public-surface-smoke] ",
      );
      if (!publicSurfaceSmoke?.ok) {
        throw new Error(
          `bundle public-surface smoke did not print ok:true JSON\n${publicSurfaceResult.output}`,
        );
      }
      if ((publicSurfaceSmoke.results ?? []).length !== disabledPublicSurfaces.length) {
        throw new Error(
          `bundle public-surface smoke result count mismatch\n${publicSurfaceResult.output}`,
        );
      }
    }

    const result = await runBundle(tmpRoot, homeDir, extensionsDir);
    const forbiddenHit = FORBIDDEN_OUTPUT.find((needle) => result.output.includes(needle));
    if (forbiddenHit) {
      throw new Error(
        `bundle smoke output contained forbidden text: ${forbiddenHit}\n${result.output}`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `bundle smoke exited nonzero: ${result.code ?? result.signal}\n${result.output}`,
      );
    }
    const smoke = parseSmokeLine(result.output);
    if (!smoke) {
      throw new Error(`bundle smoke did not print [bundle-smoke] ok:true JSON\n${result.output}`);
    }
    if (!Number.isInteger(smoke.pluginCount) || smoke.pluginCount <= 0) {
      throw new Error(`bundle smoke loaded no plugins\n${result.output}`);
    }
    const pluginIds = Array.isArray(smoke.pluginIds) ? smoke.pluginIds : [];
    for (const pluginId of REQUIRED_PLUGIN_IDS) {
      if (!pluginIds.includes(pluginId)) {
        throw new Error(
          `bundle smoke missing required plugin ${pluginId}; loaded: ${pluginIds.join(", ") || "<none>"}\n${result.output}`,
        );
      }
    }
    const pluginLoadProfileCount = result.output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("[plugin-load-profile]")).length;
    console.log(
      JSON.stringify({
        ok: true,
        assetDir: path.relative(REPO_ROOT, assetDir),
        elapsedMs: result.elapsedMs,
        bundleSmoke: smoke,
        pluginLoadProfileCount,
        publicSurfaceSmoke,
      }),
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`smoke-sandbox-bundle-local: ${err?.stack || err}\n`);
  process.exit(1);
});
