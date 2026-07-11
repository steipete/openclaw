#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  findReachableTelegramDurableAckProducer,
  readSandboxArchiveJavaScriptModules,
} from "./lib/sandbox-bundle-capability-proof.mjs";

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
  "runtime-plugins.tar.gz",
  "external-plugins.json",
  "bundle-capabilities.json",
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
  "bundle-capabilities.json",
  "channels.tar.gz",
  "external-plugins.json",
  "runtime-plugins.tar.gz",
  "openclaw.bundle.mjs",
  "release.json",
];
const REQUIRED_CAPABILITIES = [
  "admin-http-rpc-v1",
  "cron-projection-v1",
  "gateway-suspend-v1",
  "telegram-durable-ack-v1",
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function requireExactSha(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? "")) {
    fail(`${label} must be an exact 40-character lowercase git SHA`);
  }
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

async function sha256File(fileName) {
  return createHash("sha256")
    .update(await readFile(path.join(OUT_DIR, fileName)))
    .digest("hex");
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

function readTarEntry(fileName, entryName) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xOf", fileName, entryName], {
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
        resolve(stdout);
      } else {
        reject(
          new Error(
            `tar -xOf ${fileName} ${entryName} exited with code ${code ?? signal}: ${stderr}`,
          ),
        );
      }
    });
  });
}

async function verifyPackagedTelegramDurableAck(hasSharedChunks) {
  const archives = ["channels.tar.gz"];
  if (hasSharedChunks) {
    archives.push("channel-shared-chunks.tar.gz");
  }
  const modules = await readSandboxArchiveJavaScriptModules({
    archives: archives.map((fileName) => ({
      archivePath: path.join(OUT_DIR, fileName),
      fileName,
    })),
  });
  if (
    !(await findReachableTelegramDurableAckProducer({
      modules,
      readText: (module) => module.content.toString("utf8"),
    }))
  ) {
    fail(
      "packaged Telegram runtime lacks durable enqueue -> acceptance header -> 200 response ordering",
    );
  }
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

  const externalPlugins = await readJson(path.join(OUT_DIR, "external-plugins.json"));
  if (externalPlugins.schemaVersion !== 1 || !Array.isArray(externalPlugins.plugins)) {
    fail("external-plugins.json has invalid schemaVersion or plugins");
  }
  const externalPluginArtifacts = externalPlugins.plugins.map((plugin) => plugin.artifact);
  for (const plugin of externalPlugins.plugins) {
    await fileSize(plugin.artifact);
    if ((await sha256File(plugin.artifact)) !== plugin.sha256) {
      fail(`external plugin artifact digest mismatch for ${plugin.id}`);
    }
  }
  const expectedReleaseTarEntries = [
    ...RELEASE_TAR_REQUIRED_ENTRIES,
    ...externalPluginArtifacts,
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
  const runtimePluginEntries = await listTarEntries("runtime-plugins.tar.gz");
  for (const entry of [
    "admin-http-rpc/index.js",
    "admin-http-rpc/openclaw.plugin.json",
    "admin-http-rpc/package.json",
  ]) {
    if (!runtimePluginEntries.includes(entry)) {
      fail(`runtime-plugins.tar.gz lacks required entry ${entry}`);
    }
  }
  const adminPackage = JSON.parse(
    await readTarEntry("runtime-plugins.tar.gz", "admin-http-rpc/package.json"),
  );
  const adminManifest = JSON.parse(
    await readTarEntry("runtime-plugins.tar.gz", "admin-http-rpc/openclaw.plugin.json"),
  );
  if (
    adminPackage.name !== "@openclaw/admin-http-rpc" ||
    !adminPackage.openclaw?.extensions?.includes("./index.js") ||
    adminManifest.id !== "admin-http-rpc" ||
    !adminManifest.activation?.onConfigPaths?.includes("plugins.entries.admin-http-rpc") ||
    !adminManifest.contracts?.gatewayMethodDispatch?.includes("authenticated-request")
  ) {
    fail("runtime-plugins.tar.gz has invalid admin-http-rpc contract");
  }
  const adminSource = (
    await Promise.all(
      runtimePluginEntries
        .filter((entry) => entry.startsWith("admin-http-rpc/") && entry.endsWith(".js"))
        .map((entry) => readTarEntry("runtime-plugins.tar.gz", entry)),
    )
  ).join("\n");
  for (const method of [
    "gateway.suspend.prepare",
    "gateway.suspend.status",
    "gateway.suspend.resume",
  ]) {
    if (!adminSource.includes(method)) {
      fail(`runtime-plugins.tar.gz admin-http-rpc lacks ${method}`);
    }
  }
  await verifyPackagedTelegramDurableAck(typeof sizes["channel-shared-chunks.tar.gz"] === "number");

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
  const capabilities = await readJson(path.join(OUT_DIR, "bundle-capabilities.json"));
  requireExactSha(release.forkSha, "release.json forkSha");
  requireExactSha(release.upstreamSha, "release.json upstreamSha");
  if (typeof release.bundleSha256 !== "string" || release.bundleSha256.length === 0) {
    fail("release.json lacks bundleSha256");
  }
  if (capabilities.schemaVersion !== 1 || capabilities.profile !== manifest.profile) {
    fail("bundle-capabilities.json has invalid schemaVersion or profile");
  }
  if (
    JSON.stringify([...(capabilities.capabilities ?? [])].toSorted()) !==
    JSON.stringify(REQUIRED_CAPABILITIES)
  ) {
    fail(
      `bundle-capabilities.json capabilities must be exactly: ${REQUIRED_CAPABILITIES.join(", ")}`,
    );
  }
  if (
    JSON.stringify([...(contract.capabilities ?? [])].toSorted()) !==
    JSON.stringify(capabilities.capabilities)
  ) {
    fail("bundle-contract.json capabilities do not match bundle-capabilities.json");
  }
  if (!capabilities.pluginIds?.includes("admin-http-rpc")) {
    fail("bundle-capabilities.json lacks admin-http-rpc plugin");
  }
  if (!capabilities.pluginIds?.includes("slack")) {
    fail("bundle-capabilities.json lacks Slack plugin");
  }
  if (!capabilities.pluginIds?.includes("telegram")) {
    fail("bundle-capabilities.json lacks Telegram plugin");
  }
  if (
    JSON.stringify(capabilities.externalPlugins) !== JSON.stringify(externalPlugins.plugins) ||
    JSON.stringify(contract.externalPlugins) !== JSON.stringify(externalPlugins.plugins) ||
    JSON.stringify(release.externalPlugins) !== JSON.stringify(externalPlugins.plugins)
  ) {
    fail("external plugin metadata differs across bundle manifests");
  }
  if (
    JSON.stringify(capabilities.package) !== JSON.stringify(release.package) ||
    JSON.stringify(capabilities.source) !== JSON.stringify(release.source) ||
    JSON.stringify(contract.package) !== JSON.stringify(release.package) ||
    JSON.stringify(contract.source) !== JSON.stringify(release.source)
  ) {
    fail("release.json identity does not match bundle-capabilities.json");
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
      runtimePluginsTarBytes: sizes["runtime-plugins.tar.gz"],
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
