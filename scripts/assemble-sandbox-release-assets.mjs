#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const ASSET_DIR = path.join(OUT_DIR, "release-assets");
const PROFILE_NAME = process.env.OPENCLAW_BUNDLE_PROFILE ?? "sandbox";

const REQUIRED_ASSETS = [
  ["openclaw.bundle.mjs", "entry"],
  ["bundle-deps.tar.gz", "runtime-deps"],
  ["bundle-openclaw-pkg.tar.gz", "openclaw-package-shim"],
  ["channels.tar.gz", "bundled-channel-extensions"],
  ["runtime-plugins.tar.gz", "explicit-runtime-plugins"],
  ["external-plugins.json", "external-plugin-metadata"],
  ["bundle-capabilities.json", "bundle-capabilities"],
  ["channel-catalog.json", "channel-catalog"],
  ["workspace-templates.tar.gz", "workspace-templates"],
  ["control-ui.tar.gz", "control-ui-assets"],
  ["release.json", "release-metadata"],
  ["bundle-contract.json", "bundle-contract"],
];
const OPTIONAL_ASSETS = new Map([
  ["channel-shared-chunks.tar.gz", "bundled-channel-shared-dist-chunks"],
]);

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

function gitRevParse(ref) {
  const result = spawnSync("git", ["rev-parse", ref], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function assetRecord(fileName, role) {
  const filePath = path.join(ASSET_DIR, fileName);
  const info = await stat(filePath);
  return { role, bytes: info.size, sha256: await sha256File(filePath) };
}

async function copyRequiredAsset(fileName) {
  const source = path.join(OUT_DIR, fileName);
  const info = await stat(source).catch((err) => {
    if (err?.code === "ENOENT") {
      throw new Error("missing required sandbox bundle asset: " + path.relative(REPO_ROOT, source));
    }
    throw err;
  });
  if (!info.isFile() || info.size <= 0) {
    throw new Error("invalid sandbox bundle asset: " + path.relative(REPO_ROOT, source));
  }
  await copyFile(source, path.join(ASSET_DIR, fileName));
}

async function copyOptionalAsset(fileName) {
  const source = path.join(OUT_DIR, fileName);
  const info = await stat(source).catch(() => null);
  if (!info) {
    return false;
  }
  if (!info.isFile() || info.size <= 0) {
    throw new Error("invalid optional sandbox bundle asset: " + path.relative(REPO_ROOT, source));
  }
  await copyFile(source, path.join(ASSET_DIR, fileName));
  return true;
}

async function createTarball(fileName, entries, cwd = ASSET_DIR) {
  await run("tar", ["-czf", path.join(ASSET_DIR, fileName), ...entries], {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function createSupportAssets() {
  await copyFile(
    path.join(REPO_ROOT, "dist", "channel-catalog.json"),
    path.join(ASSET_DIR, "channel-catalog.json"),
  );

  const templatesDir = path.join(REPO_ROOT, "docs", "reference", "templates");
  const templatesInfo = await stat(templatesDir).catch((err) => {
    if (err?.code === "ENOENT") {
      throw new Error("missing workspace templates dir: " + path.relative(REPO_ROOT, templatesDir));
    }
    throw err;
  });
  if (!templatesInfo.isDirectory()) {
    throw new Error(
      "workspace templates path is not a directory: " + path.relative(REPO_ROOT, templatesDir),
    );
  }
  await createTarball(
    "workspace-templates.tar.gz",
    ["templates"],
    path.join(REPO_ROOT, "docs", "reference"),
  );

  const controlUiDir = path.join(REPO_ROOT, "dist", "control-ui");
  const controlUiIndex = path.join(controlUiDir, "index.html");
  const controlUiInfo = await stat(controlUiIndex).catch((err) => {
    if (err?.code === "ENOENT") {
      throw new Error(
        "missing Control UI build: " +
          path.relative(REPO_ROOT, controlUiIndex) +
          ". Run pnpm ui:build before assembling sandbox release assets.",
      );
    }
    throw err;
  });
  if (!controlUiInfo.isFile()) {
    throw new Error("Control UI index is not a file: " + path.relative(REPO_ROOT, controlUiIndex));
  }
  await createTarball("control-ui.tar.gz", ["control-ui"], path.join(REPO_ROOT, "dist"));
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const packageVersion = pkg.version;
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("package.json is missing version");
  }
  const sha = gitRevParse("HEAD");
  if (!sha) {
    throw new Error("unable to resolve git HEAD sha");
  }
  const sha7 = sha.slice(0, 7);
  const canonicalTarName = "openclaw-sandbox-bundle-v" + packageVersion + "-" + sha7 + ".tar.gz";

  await rm(ASSET_DIR, { recursive: true, force: true });
  await mkdir(ASSET_DIR, { recursive: true });

  await createSupportAssets();
  for (const [fileName] of REQUIRED_ASSETS) {
    if (
      ["channel-catalog.json", "workspace-templates.tar.gz", "control-ui.tar.gz"].includes(fileName)
    ) {
      continue;
    }
    await copyRequiredAsset(fileName);
  }
  const externalPluginManifest = JSON.parse(
    await readFile(path.join(ASSET_DIR, "external-plugins.json"), "utf8"),
  );
  const externalPluginAssets = [];
  for (const plugin of externalPluginManifest.plugins ?? []) {
    if (
      typeof plugin?.artifact !== "string" ||
      path.basename(plugin.artifact) !== plugin.artifact
    ) {
      throw new Error("external-plugins.json contains invalid artifact path");
    }
    await copyRequiredAsset(plugin.artifact);
    externalPluginAssets.push(plugin.artifact);
  }
  if (externalPluginAssets.length === 0) {
    throw new Error("external-plugins.json contains no plugin artifacts");
  }
  const optionalAssets = [];
  for (const [fileName] of OPTIONAL_ASSETS) {
    if (await copyOptionalAsset(fileName)) {
      optionalAssets.push(fileName);
    }
  }

  const assetNames = [
    ...REQUIRED_ASSETS.map(([fileName]) => fileName),
    ...externalPluginAssets,
    ...optionalAssets,
  ];
  await createTarball(canonicalTarName, assetNames);

  const assets = {};
  for (const [fileName, role] of REQUIRED_ASSETS) {
    assets[fileName] = await assetRecord(fileName, role);
  }
  for (const fileName of optionalAssets) {
    assets[fileName] = await assetRecord(fileName, OPTIONAL_ASSETS.get(fileName));
  }
  for (const fileName of externalPluginAssets) {
    assets[fileName] = await assetRecord(fileName, "external-plugin-package");
  }
  assets[canonicalTarName] = await assetRecord(canonicalTarName, "canonical-release-tarball");

  const capabilities = JSON.parse(
    await readFile(path.join(ASSET_DIR, "bundle-capabilities.json"), "utf8"),
  );
  const packageName = pkg.name ?? "openclaw";
  if (
    capabilities.package?.name !== packageName ||
    capabilities.package?.version !== packageVersion
  ) {
    throw new Error("bundle-capabilities.json package identity does not match package.json");
  }
  if (capabilities.source?.fork?.sha !== sha) {
    throw new Error("bundle-capabilities.json fork SHA does not match git HEAD");
  }
  const requestedTag =
    process.env.OPENCLAW_BUNDLE_FORK_REF || process.env.INPUT_TAG || process.env.GITHUB_REF_NAME;
  const tag = requestedTag ?? capabilities.source?.fork?.ref;
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("bundle-capabilities.json lacks source.fork.ref");
  }
  if (tag !== capabilities.source.fork.ref) {
    throw new Error(
      `requested bundle tag ${tag} does not match source fork ref ${capabilities.source.fork.ref}`,
    );
  }

  const manifest = {
    schemaVersion: 2,
    name: "openclaw-sandbox-bundle",
    profile: PROFILE_NAME,
    package: capabilities.package,
    source: capabilities.source,
    capabilityManifest: "bundle-capabilities.json",
    externalPlugins: capabilities.externalPlugins,
    tag,
    git: {
      sha,
      sha7,
      upstreamSha: capabilities.source?.upstream?.sha,
    },
    runtime: { nodeTarget: "node22", engines: pkg.engines?.node ?? ">=22.14.0" },
    canonicalTarball: canonicalTarName,
    assets,
  };
  await writeFile(
    path.join(ASSET_DIR, "asset-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  const uploadedAssets = [canonicalTarName, ...assetNames, "asset-manifest.json"].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const checksumLines = [];
  for (const fileName of uploadedAssets) {
    checksumLines.push((await sha256File(path.join(ASSET_DIR, fileName))) + "  " + fileName);
  }
  await writeFile(path.join(ASSET_DIR, "checksums.sha256"), checksumLines.join("\n") + "\n");

  const entries = (await readdir(ASSET_DIR)).toSorted((left, right) => left.localeCompare(right));
  console.log(
    JSON.stringify({
      ok: true,
      assetDir: path.relative(REPO_ROOT, ASSET_DIR),
      canonicalTarball: canonicalTarName,
      uploadedAssetCount: entries.length,
      uploadedAssets: entries,
    }),
  );
}

main().catch((err) => {
  process.stderr.write("assemble-sandbox-release-assets: " + (err?.stack || err) + "\n");
  process.exit(1);
});
