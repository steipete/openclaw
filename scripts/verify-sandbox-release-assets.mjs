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
import {
  assertSandboxBundleCapabilities,
  assertSandboxBundleCapabilityHooks,
} from "./lib/sandbox-bundle-capabilities.mjs";
import { assertSafeSandboxArchive, sandboxArchiveLimits } from "./lib/sandbox-archive-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox", "release-assets");
const PROFILE_PATH = path.join(REPO_ROOT, ".fork", "bundle-profile.sandbox.json");
const REQUIRED_ASSETS = [
  "openclaw.bundle.mjs",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "runtime-plugins.tar.gz",
  "external-plugins.json",
  "bundle-capabilities.json",
  "channel-catalog.json",
  "workspace-templates.tar.gz",
  "control-ui.tar.gz",
  "release.json",
  "bundle-contract.json",
  "asset-manifest.json",
  "checksums.sha256",
];
const REQUIRED_TAR_ENTRIES = [
  "bundle-capabilities.json",
  "bundle-contract.json",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "external-plugins.json",
  "runtime-plugins.tar.gz",
  "channel-catalog.json",
  "control-ui.tar.gz",
  "openclaw.bundle.mjs",
  "release.json",
  "workspace-templates.tar.gz",
];
const REQUIRED_PLUGIN_IDS = ["admin-http-rpc", "slack", "telegram"];

function parseArgs(argv) {
  const args = { assetDir: process.env.OPENCLAW_SANDBOX_BUNDLE_ASSET_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asset-dir") {
      args.assetDir = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: verify-sandbox-release-assets [--asset-dir <dir>]");
      process.exit(0);
    }
    throw new Error("unknown argument: " + arg);
  }
  return { assetDir: path.resolve(args.assetDir ?? DEFAULT_ASSET_DIR) };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function requireFile(assetDir, fileName) {
  const filePath = path.join(assetDir, fileName);
  const info = await stat(filePath).catch((err) => {
    if (err?.code === "ENOENT") {
      throw new Error("missing release asset: " + path.relative(REPO_ROOT, filePath));
    }
    throw err;
  });
  if (!info.isFile() || info.size <= 0) {
    throw new Error("invalid release asset: " + path.relative(REPO_ROOT, filePath));
  }
  return info;
}

function listTarEntries(assetDir, fileName) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tzf", fileName], {
      cwd: assetDir,
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
      } else {
        reject(
          new Error("tar -tzf " + fileName + " exited with " + (code ?? signal) + ": " + stderr),
        );
      }
    });
  });
}

function readTarEntry(assetDir, fileName, entryName) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xOf", fileName, entryName], {
      cwd: assetDir,
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
          new Error(`tar -xOf ${fileName} ${entryName} exited with ${code ?? signal}: ${stderr}`),
        );
      }
    });
  });
}

function parseChecksums(raw) {
  const entries = new Map();
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (!line.trim()) {
      continue;
    }
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) {
      throw new Error("invalid checksums.sha256 line " + (index + 1) + ": " + line);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function extractCatalogChannelIds(catalog) {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  return entries
    .map((entry) => entry?.openclaw?.channel?.id)
    .filter((id) => typeof id === "string" && id.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

function requireTarEntry(entries, fileName, expectedEntry) {
  if (!entries.includes(expectedEntry)) {
    throw new Error(fileName + " missing required entry: " + expectedEntry);
  }
}

function requireExactSha(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? "")) {
    throw new Error(label + " must be an exact 40-character lowercase git SHA");
  }
}

function requireStringSetIncludes(actual, required, label) {
  if (!Array.isArray(actual) || actual.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(label + " must be a non-empty string array");
  }
  for (const value of required) {
    if (!actual.includes(value)) {
      throw new Error(label + " lacks required value: " + value);
    }
  }
}

async function verifyPackagedTelegramDurableAck(assetDir) {
  const archives = ["channels.tar.gz"];
  const sharedChunksPath = path.join(assetDir, "channel-shared-chunks.tar.gz");
  if (await stat(sharedChunksPath).catch(() => null)) {
    archives.push("channel-shared-chunks.tar.gz");
  }
  const modules = await readSandboxArchiveJavaScriptModules({
    archives: archives.map((fileName) => ({
      archivePath: path.join(assetDir, fileName),
      fileName,
    })),
  });
  if (
    !(await findReachableTelegramDurableAckProducer({
      modules,
      readText: (module) => module.content.toString("utf8"),
    }))
  ) {
    throw new Error(
      "packaged Telegram runtime lacks durable enqueue -> acceptance header -> 200 response ordering",
    );
  }
}

function verifyCapabilityManifest(manifest, capabilities, externalPlugins, bundleSource) {
  if (capabilities.schemaVersion !== 1 || capabilities.profile !== "sandbox") {
    throw new Error("bundle-capabilities.json has invalid schemaVersion or profile");
  }
  assertSandboxBundleCapabilities(capabilities.capabilities, "bundle-capabilities.json");
  assertSandboxBundleCapabilityHooks({
    capabilities: capabilities.capabilities,
    bundleSource,
    label: "openclaw.bundle.mjs",
  });
  requireStringSetIncludes(
    capabilities.pluginIds,
    REQUIRED_PLUGIN_IDS,
    "bundle-capabilities.json pluginIds",
  );
  requireExactSha(capabilities.source?.fork?.sha, "bundle-capabilities.json fork SHA");
  requireExactSha(capabilities.source?.upstream?.sha, "bundle-capabilities.json upstream SHA");
  if (
    capabilities.source?.fork?.repository !== "vercel-labs/openclaw" ||
    capabilities.source?.upstream?.repository !== "openclaw/openclaw" ||
    typeof capabilities.source?.fork?.ref !== "string" ||
    !capabilities.source.fork.ref
  ) {
    throw new Error("bundle-capabilities.json source repository or ref is invalid");
  }
  if (
    JSON.stringify(capabilities.package) !== JSON.stringify(manifest.package) ||
    JSON.stringify(capabilities.source) !== JSON.stringify(manifest.source)
  ) {
    throw new Error("asset-manifest.json identity does not match bundle-capabilities.json");
  }
  if (
    JSON.stringify(capabilities.externalPlugins) !== JSON.stringify(externalPlugins.plugins) ||
    JSON.stringify(manifest.externalPlugins) !== JSON.stringify(externalPlugins.plugins)
  ) {
    throw new Error("external plugin metadata differs across bundle manifests");
  }
}

async function verifyNestedAssets(assetDir, contract, externalPlugins) {
  const channelsEntries = await listTarEntries(assetDir, "channels.tar.gz");
  const catalog = await readJson(path.join(assetDir, "channel-catalog.json"));
  const catalogChannelIds = extractCatalogChannelIds(catalog);
  if (catalogChannelIds.length === 0) {
    throw new Error("channel-catalog.json has no channel entries");
  }
  const archivedChannelIds = channelsEntries
    .filter((entry) => /^[^/]+\/package\.json$/u.test(entry))
    .map((entry) => entry.slice(0, -"/package.json".length))
    .toSorted((left, right) => left.localeCompare(right));
  if (archivedChannelIds.length === 0) {
    throw new Error("channels.tar.gz contains no channel package.json entries");
  }
  requireTarEntry(channelsEntries, "channels.tar.gz", "telegram/package.json");
  requireTarEntry(channelsEntries, "channels.tar.gz", "telegram/index.js");
  await verifyPackagedTelegramDurableAck(assetDir);

  const runtimePluginEntries = await listTarEntries(assetDir, "runtime-plugins.tar.gz");
  requireTarEntry(runtimePluginEntries, "runtime-plugins.tar.gz", "admin-http-rpc/package.json");
  requireTarEntry(runtimePluginEntries, "runtime-plugins.tar.gz", "admin-http-rpc/index.js");
  requireTarEntry(
    runtimePluginEntries,
    "runtime-plugins.tar.gz",
    "admin-http-rpc/openclaw.plugin.json",
  );
  const adminPackage = JSON.parse(
    await readTarEntry(assetDir, "runtime-plugins.tar.gz", "admin-http-rpc/package.json"),
  );
  const adminManifest = JSON.parse(
    await readTarEntry(assetDir, "runtime-plugins.tar.gz", "admin-http-rpc/openclaw.plugin.json"),
  );
  if (
    adminPackage.name !== "@openclaw/admin-http-rpc" ||
    !adminPackage.openclaw?.extensions?.includes("./index.js") ||
    adminManifest.id !== "admin-http-rpc" ||
    !adminManifest.activation?.onConfigPaths?.includes("plugins.entries.admin-http-rpc") ||
    !adminManifest.contracts?.gatewayMethodDispatch?.includes("authenticated-request")
  ) {
    throw new Error("runtime-plugins.tar.gz has invalid admin-http-rpc contract");
  }
  const adminSource = (
    await Promise.all(
      runtimePluginEntries
        .filter((entry) => entry.startsWith("admin-http-rpc/") && entry.endsWith(".js"))
        .map((entry) => readTarEntry(assetDir, "runtime-plugins.tar.gz", entry)),
    )
  ).join("\n");
  for (const method of [
    "gateway.suspend.prepare",
    "gateway.suspend.status",
    "gateway.suspend.resume",
  ]) {
    if (!adminSource.includes(method)) {
      throw new Error(`runtime-plugins.tar.gz admin-http-rpc lacks ${method}`);
    }
  }

  for (const plugin of externalPlugins.plugins) {
    const packageEntries = await listTarEntries(assetDir, plugin.artifact);
    requireTarEntry(packageEntries, plugin.artifact, "package/package.json");
    requireTarEntry(packageEntries, plugin.artifact, "package/openclaw.plugin.json");
    if (
      !packageEntries.some((entry) => entry.startsWith("package/dist/") && entry.endsWith(".js"))
    ) {
      throw new Error(plugin.artifact + " contains no compiled runtime files");
    }
    const packageJson = JSON.parse(
      await readTarEntry(assetDir, plugin.artifact, "package/package.json"),
    );
    const pluginManifest = JSON.parse(
      await readTarEntry(assetDir, plugin.artifact, "package/openclaw.plugin.json"),
    );
    if (
      packageJson.name !== plugin.packageName ||
      packageJson.version !== plugin.version ||
      pluginManifest.id !== plugin.id
    ) {
      throw new Error(plugin.artifact + " package identity does not match external-plugins.json");
    }
  }

  const shimEntries = await listTarEntries(assetDir, "bundle-openclaw-pkg.tar.gz");
  requireTarEntry(shimEntries, "bundle-openclaw-pkg.tar.gz", "package.json");
  requireTarEntry(shimEntries, "bundle-openclaw-pkg.tar.gz", "node_modules/openclaw/package.json");
  const pluginSdkSubpaths = Array.isArray(contract?.pluginSdkSubpaths)
    ? contract.pluginSdkSubpaths
    : [];
  if (pluginSdkSubpaths.length === 0) {
    throw new Error("bundle-contract.json pluginSdkSubpaths is empty");
  }
  for (const subpath of pluginSdkSubpaths) {
    if (typeof subpath !== "string" || subpath.length === 0) {
      throw new Error("bundle-contract.json has invalid pluginSdkSubpaths entry");
    }
    requireTarEntry(
      shimEntries,
      "bundle-openclaw-pkg.tar.gz",
      "node_modules/openclaw/plugin-sdk/" + subpath + ".cjs",
    );
  }

  const controlUiEntries = await listTarEntries(assetDir, "control-ui.tar.gz");
  requireTarEntry(controlUiEntries, "control-ui.tar.gz", "control-ui/index.html");

  const templateEntries = await listTarEntries(assetDir, "workspace-templates.tar.gz");
  if (!templateEntries.some((entry) => entry.startsWith("templates/") && entry !== "templates/")) {
    throw new Error("workspace-templates.tar.gz contains no template files");
  }
}

async function main() {
  const { assetDir } = parseArgs(process.argv.slice(2));
  const profile = await readJson(PROFILE_PATH);
  const archiveLimits = sandboxArchiveLimits(profile.budgets);
  for (const fileName of REQUIRED_ASSETS) {
    await requireFile(assetDir, fileName);
  }

  const manifest = await readJson(path.join(assetDir, "asset-manifest.json"));
  const contract = await readJson(path.join(assetDir, "bundle-contract.json"));
  const release = await readJson(path.join(assetDir, "release.json"));
  const capabilities = await readJson(path.join(assetDir, "bundle-capabilities.json"));
  const externalPlugins = await readJson(path.join(assetDir, "external-plugins.json"));
  if (externalPlugins.schemaVersion !== 1 || !Array.isArray(externalPlugins.plugins)) {
    throw new Error("external-plugins.json has invalid schemaVersion or plugins");
  }
  if (manifest.schemaVersion !== 2) {
    throw new Error("asset-manifest.json schemaVersion must be 2");
  }
  if (manifest.capabilityManifest !== "bundle-capabilities.json") {
    throw new Error("asset-manifest.json capabilityManifest mismatch");
  }
  verifyCapabilityManifest(
    manifest,
    capabilities,
    externalPlugins,
    await readFile(path.join(assetDir, "openclaw.bundle.mjs"), "utf8"),
  );
  if (
    release.schemaVersion !== 2 ||
    release.capabilityManifest !== "bundle-capabilities.json" ||
    release.bundleSha256 !== (await sha256File(path.join(assetDir, "openclaw.bundle.mjs"))) ||
    manifest.tag !== manifest.source?.fork?.ref ||
    manifest.git?.sha !== manifest.source?.fork?.sha ||
    manifest.git?.sha7 !== manifest.source?.fork?.sha?.slice(0, 7) ||
    manifest.git?.upstreamSha !== manifest.source?.upstream?.sha ||
    release.forkSha !== manifest.source?.fork?.sha ||
    release.forkRef !== manifest.source?.fork?.ref ||
    release.upstreamSha !== manifest.source?.upstream?.sha ||
    contract.packageVersion !== manifest.package?.version
  ) {
    throw new Error("release source identity differs across bundle manifests");
  }
  if (
    JSON.stringify(release.package) !== JSON.stringify(manifest.package) ||
    JSON.stringify(release.source) !== JSON.stringify(manifest.source) ||
    JSON.stringify(contract.package) !== JSON.stringify(manifest.package) ||
    JSON.stringify(contract.source) !== JSON.stringify(manifest.source) ||
    JSON.stringify(release.externalPlugins) !== JSON.stringify(externalPlugins.plugins) ||
    JSON.stringify(contract.externalPlugins) !== JSON.stringify(externalPlugins.plugins)
  ) {
    throw new Error("release identity differs across bundle manifests");
  }
  assertSandboxBundleCapabilities(contract.capabilities, "bundle-contract.json");
  if (JSON.stringify(contract.capabilities) !== JSON.stringify(capabilities.capabilities)) {
    throw new Error("bundle-contract.json capabilities do not match bundle-capabilities.json");
  }
  if (manifest.name !== "openclaw-sandbox-bundle" || manifest.profile !== "sandbox") {
    throw new Error("asset-manifest.json does not describe the sandbox bundle");
  }
  if (
    typeof manifest.canonicalTarball !== "string" ||
    !manifest.canonicalTarball.endsWith(".tar.gz")
  ) {
    throw new Error("asset-manifest.json lacks canonicalTarball");
  }
  await requireFile(assetDir, manifest.canonicalTarball);

  const manifestAssets = manifest.assets;
  if (!manifestAssets || typeof manifestAssets !== "object" || Array.isArray(manifestAssets)) {
    throw new Error("asset-manifest.json lacks assets object");
  }
  for (const fileName of REQUIRED_ASSETS.filter(
    (entry) => entry !== "checksums.sha256" && entry !== "asset-manifest.json",
  )) {
    if (!manifestAssets[fileName]) {
      throw new Error("asset-manifest.json lacks assets." + fileName);
    }
  }
  if (!manifestAssets[manifest.canonicalTarball]) {
    throw new Error("asset-manifest.json lacks canonical tarball digest");
  }
  const externalPluginArtifacts = [];
  for (const plugin of externalPlugins.plugins) {
    if (
      plugin.id !== "slack" ||
      plugin.packageName !== "@openclaw/slack" ||
      plugin.version !== manifest.package?.version ||
      plugin.spec !== `@openclaw/slack@${manifest.package?.version}` ||
      typeof plugin.artifact !== "string" ||
      path.basename(plugin.artifact) !== plugin.artifact ||
      typeof plugin.sha256 !== "string"
    ) {
      throw new Error("external-plugins.json has invalid Slack identity");
    }
    await requireFile(assetDir, plugin.artifact);
    if (manifestAssets[plugin.artifact]?.bytes > profile.budgets.externalPluginTarMaxBytes) {
      throw new Error("external plugin exceeds compressed size budget: " + plugin.artifact);
    }
    if (!manifestAssets[plugin.artifact]) {
      throw new Error("asset-manifest.json lacks external plugin asset " + plugin.artifact);
    }
    if (manifestAssets[plugin.artifact].sha256 !== plugin.sha256) {
      throw new Error("external plugin digest differs across manifests for " + plugin.id);
    }
    const integrity = /^sha512-(.+)$/u.exec(plugin.integrity ?? "");
    const actualIntegrity = createHash("sha512")
      .update(await readFile(path.join(assetDir, plugin.artifact)))
      .digest("base64");
    if (!integrity || integrity[1] !== actualIntegrity) {
      throw new Error("external plugin npm integrity mismatch for " + plugin.id);
    }
    externalPluginArtifacts.push(plugin.artifact);
  }
  if (externalPluginArtifacts.length !== 1) {
    throw new Error("external-plugins.json must contain exactly the Slack package");
  }

  const optionalChunk = path.join(assetDir, "channel-shared-chunks.tar.gz");
  const hasOptionalChunk = Boolean(await stat(optionalChunk).catch(() => null));
  if (hasOptionalChunk && !manifestAssets["channel-shared-chunks.tar.gz"]) {
    throw new Error("channel-shared-chunks.tar.gz exists but is absent from asset-manifest.json");
  }
  if (manifestAssets["channel-shared-chunks.tar.gz"] && !hasOptionalChunk) {
    throw new Error("asset-manifest.json lists channel-shared-chunks.tar.gz but file is missing");
  }

  for (const [fileName, record] of Object.entries(manifestAssets)) {
    const info = await requireFile(assetDir, fileName);
    if (record.bytes !== info.size) {
      throw new Error(
        "asset-manifest.json byte mismatch for " +
          fileName +
          ": " +
          record.bytes +
          " !== " +
          info.size,
      );
    }
    const actualSha = await sha256File(path.join(assetDir, fileName));
    if (record.sha256 !== actualSha) {
      throw new Error("asset-manifest.json sha256 mismatch for " + fileName);
    }
  }

  const expectedTarEntries = [
    ...REQUIRED_TAR_ENTRIES,
    ...externalPluginArtifacts,
    ...(hasOptionalChunk ? ["channel-shared-chunks.tar.gz"] : []),
  ].toSorted((left, right) => left.localeCompare(right));
  const actualTarEntries = (await listTarEntries(assetDir, manifest.canonicalTarball)).toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (JSON.stringify(actualTarEntries) !== JSON.stringify(expectedTarEntries)) {
    throw new Error(
      "canonical tarball entries mismatch: expected " +
        expectedTarEntries.join(", ") +
        "; got " +
        actualTarEntries.join(", "),
    );
  }

  for (const fileName of [
    manifest.canonicalTarball,
    "bundle-deps.tar.gz",
    "bundle-openclaw-pkg.tar.gz",
    "channels.tar.gz",
    "runtime-plugins.tar.gz",
    "control-ui.tar.gz",
    "workspace-templates.tar.gz",
    ...externalPluginArtifacts,
    ...(hasOptionalChunk ? ["channel-shared-chunks.tar.gz"] : []),
  ]) {
    await assertSafeSandboxArchive({
      archivePath: path.join(assetDir, fileName),
      archiveLabel: fileName,
      limits: archiveLimits,
    });
  }

  await verifyNestedAssets(assetDir, contract, externalPlugins);

  const checksums = parseChecksums(await readFile(path.join(assetDir, "checksums.sha256"), "utf8"));
  const expectedChecksumFiles = [
    manifest.canonicalTarball,
    ...expectedTarEntries,
    "asset-manifest.json",
  ].toSorted((left, right) => left.localeCompare(right));
  if (
    JSON.stringify([...checksums.keys()].toSorted((left, right) => left.localeCompare(right))) !==
    JSON.stringify(expectedChecksumFiles)
  ) {
    throw new Error("checksums.sha256 file list does not match release asset set");
  }
  for (const [fileName, expectedSha] of checksums) {
    const actualSha = await sha256File(path.join(assetDir, fileName));
    if (actualSha !== expectedSha) {
      throw new Error("checksums.sha256 mismatch for " + fileName);
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      assetDir: path.relative(REPO_ROOT, assetDir),
      canonicalTarball: manifest.canonicalTarball,
      assetCount: expectedChecksumFiles.length + 1,
      optionalSharedChunks: hasOptionalChunk,
    }),
  );
}

main().catch((err) => {
  process.stderr.write("verify-sandbox-release-assets: " + (err?.stack || err) + "\n");
  process.exit(1);
});
