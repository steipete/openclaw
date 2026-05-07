#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const PROFILE_NAME = process.env.OPENCLAW_BUNDLE_PROFILE ?? "sandbox";
const PROFILE_PATH = path.join(REPO_ROOT, ".fork", `bundle-profile.${PROFILE_NAME}.json`);
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");

const REQUIRED_FILES = [
  "openclaw.bundle.mjs",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "openclaw-release.tar.gz",
  "meta.json",
  "release.json",
  "bundle-contract.json",
];
const OPTIONAL_FILES = ["channel-shared-chunks.tar.gz"];

const RELEASE_TAR_REQUIRED_ENTRIES = [
  "bundle-contract.json",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "openclaw.bundle.mjs",
  "release.json",
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

async function fileSize(fileName) {
  const filePath = path.join(OUT_DIR, fileName);
  const info = await stat(filePath).catch((err) => {
    if (err?.code === "ENOENT") {
      fail(`missing required bundle artifact: ${path.relative(REPO_ROOT, filePath)}`);
    }
    throw err;
  });
  return info.size;
}

function listTarEntries(fileName) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tzf", fileName], {
      cwd: OUT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim().split(/\r?\n/u).filter(Boolean));
        return;
      }
      reject(new Error(`tar -tzf ${fileName} exited with code ${code ?? signal}: ${stderr}`));
    });
  });
}

function assertBudget(bytes, maxBytes, label) {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) {
    fail(`invalid budget for ${label}`);
  }
  if (bytes > maxBytes) {
    fail(`${label} exceeds budget: ${bytes} > ${maxBytes}`);
  }
}

function assertOutputSize(contract, outputKey, fileName, bytes, options = {}) {
  const output = contract.outputs?.[outputKey];
  if (!output || typeof output !== "object") {
    fail(`bundle-contract.json lacks outputs.${outputKey}`);
  }
  if (output.path !== fileName) {
    fail(`bundle-contract.json outputs.${outputKey}.path mismatch: ${output.path} !== ${fileName}`);
  }
  if (options.skipBytes === true) {
    return;
  }
  if (output.bytes !== bytes) {
    fail(`bundle-contract.json outputs.${outputKey}.bytes mismatch: ${output.bytes} !== ${bytes}`);
  }
}

function normalizeRepoRelative(filePath) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, filePath)).split(path.sep).join("/");
}

function inputMatchesModule(inputPath, moduleName) {
  const normalized = inputPath.split(path.sep).join("/");
  if (moduleName.startsWith("@")) {
    return (
      normalized.includes(`/node_modules/${moduleName}/`) ||
      normalized.startsWith(`node_modules/${moduleName}/`)
    );
  }
  return (
    normalized.includes(`/node_modules/${moduleName}/`) ||
    normalized.startsWith(`node_modules/${moduleName}/`)
  );
}

async function main() {
  const manifest = await readJson(PROFILE_PATH);
  const budgets = manifest.budgets ?? {};

  const sizes = {};
  for (const file of REQUIRED_FILES) {
    sizes[file] = await fileSize(file);
  }
  for (const file of OPTIONAL_FILES) {
    const maybeSize = await stat(path.join(OUT_DIR, file)).then(
      (info) => info.size,
      () => null,
    );
    if (maybeSize !== null) {
      sizes[file] = maybeSize;
    }
  }

  assertBudget(sizes["openclaw.bundle.mjs"], budgets.bundleMaxBytes, "openclaw.bundle.mjs");
  if (sizes["openclaw.bundle.mjs"] > budgets.bundleWarnBytes) {
    process.stderr.write(
      `warning: openclaw.bundle.mjs exceeds warning budget: ${sizes["openclaw.bundle.mjs"]} > ${budgets.bundleWarnBytes}\n`,
    );
  }
  assertBudget(sizes["bundle-deps.tar.gz"], budgets.runtimeDepsTarMaxBytes, "bundle-deps.tar.gz");
  assertBudget(
    sizes["bundle-openclaw-pkg.tar.gz"],
    budgets.openclawPackageTarMaxBytes,
    "bundle-openclaw-pkg.tar.gz",
  );
  assertBudget(
    sizes["openclaw-release.tar.gz"],
    budgets.releaseTarMaxBytes,
    "openclaw-release.tar.gz",
  );

  const expectedReleaseTarEntries = [
    ...RELEASE_TAR_REQUIRED_ENTRIES,
    ...(typeof sizes["channel-shared-chunks.tar.gz"] === "number"
      ? ["channel-shared-chunks.tar.gz"]
      : []),
  ].toSorted((left, right) => left.localeCompare(right));
  const releaseTarEntries = (await listTarEntries("openclaw-release.tar.gz")).toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (JSON.stringify(releaseTarEntries) !== JSON.stringify(expectedReleaseTarEntries)) {
    fail(
      `openclaw-release.tar.gz entries mismatch: expected ${expectedReleaseTarEntries.join(", ")}; got ${releaseTarEntries.join(", ")}`,
    );
  }

  // Static-import dual-load guard.
  // Bundling a static `import { ... } from "<dep>"` for a dep that is also
  // marked external + loaded via the banner's `require(...)` triggers Node 22's
  // "Unexpected status of a module that is imported again after being
  // required. Status = 0" when bundled extensions activate. Catch this at the
  // build/verify boundary instead of finding it in production logs.
  const bundleSource = await readFile(path.join(OUT_DIR, "openclaw.bundle.mjs"), "utf8");
  const externalRuntimeDeps = Array.isArray(manifest.externalRuntimeDeps)
    ? manifest.externalRuntimeDeps
    : [];
  for (const dep of externalRuntimeDeps) {
    const escapedDep = dep.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
    const staticImportPattern = new RegExp(
      String.raw`(?:^|[^\w$])import\s*(?:[\w$]+|\{[^}]*\}|\*\s+as\s+[\w$]+)?\s*(?:from\s*)?["']${escapedDep}["']`,
      "u",
    );
    if (staticImportPattern.test(bundleSource)) {
      fail(
        `bundle contains static ESM import of external runtime dep "${dep}" — this conflicts with require("${dep}") and triggers Node 22 dual-load. Convert the offending source file to lazy createRequire(import.meta.url)("${dep}").`,
      );
    }
  }

  const meta = await readJson(path.join(OUT_DIR, "meta.json"));
  const inputs = Object.keys(meta.inputs ?? {});
  for (const [moduleName, stubPath] of Object.entries(
    manifest.disabledOptionalNativeModules ?? {},
  )) {
    const normalizedStubPath = normalizeRepoRelative(stubPath);
    const realInputs = inputs.filter(
      (inputPath) => inputMatchesModule(inputPath, moduleName) && inputPath !== normalizedStubPath,
    );
    if (realInputs.length > 0) {
      fail(
        `disabled optional module ${moduleName} appeared as real esbuild input(s): ${realInputs.join(", ")}`,
      );
    }
  }

  const contract = await readJson(path.join(OUT_DIR, "bundle-contract.json"));
  if (!Array.isArray(contract.pluginSdkSubpaths) || contract.pluginSdkSubpaths.length === 0) {
    fail("bundle-contract.json pluginSdkSubpaths is empty");
  }
  assertOutputSize(contract, "bundle", "openclaw.bundle.mjs", sizes["openclaw.bundle.mjs"]);
  assertOutputSize(contract, "depsTar", "bundle-deps.tar.gz", sizes["bundle-deps.tar.gz"]);
  assertOutputSize(
    contract,
    "openclawTar",
    "bundle-openclaw-pkg.tar.gz",
    sizes["bundle-openclaw-pkg.tar.gz"],
  );
  assertOutputSize(
    contract,
    "releaseTar",
    "openclaw-release.tar.gz",
    sizes["openclaw-release.tar.gz"],
    { skipBytes: true },
  );

  const release = await readJson(path.join(OUT_DIR, "release.json"));
  if (typeof release.forkSha !== "string" || release.forkSha.length === 0) {
    fail("release.json lacks forkSha");
  }
  if (typeof release.bundleSha256 !== "string" || release.bundleSha256.length === 0) {
    fail("release.json lacks bundleSha256");
  }

  console.log(
    JSON.stringify({
      ok: true,
      profile: manifest.profile,
      bundleBytes: sizes["openclaw.bundle.mjs"],
      depsTarBytes: sizes["bundle-deps.tar.gz"],
      pkgTarBytes: sizes["bundle-openclaw-pkg.tar.gz"],
      releaseTarBytes: sizes["openclaw-release.tar.gz"],
      channelsTarBytes: sizes["channels.tar.gz"],
      sharedChunksTarBytes: sizes["channel-shared-chunks.tar.gz"] ?? null,
      pluginSdkSubpathCount: contract.pluginSdkSubpaths.length,
      disabledPublicSurfaceCount: Array.isArray(contract.disabledPublicSurfaces)
        ? contract.disabledPublicSurfaces.length
        : 0,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`verify-sandbox-bundle-contract: ${err?.stack || err}\n`);
  process.exit(1);
});
