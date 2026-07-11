#!/usr/bin/env node

/** Package exact published external plugins for offline sandbox installation. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const OUT_MANIFEST = path.join(OUT_DIR, "external-plugins.json");
const PROFILE_NAME = process.env.OPENCLAW_BUNDLE_PROFILE ?? "sandbox";
const PROFILE_PATH = path.join(REPO_ROOT, ".fork", `bundle-profile.${PROFILE_NAME}.json`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function readTarEntry(archivePath, entry) {
  return run("tar", ["-xOf", archivePath, entry]);
}

function listTarEntries(archivePath) {
  return run("tar", ["-tzf", archivePath]).trim().split(/\r?\n/u).filter(Boolean);
}

async function hashFile(filePath, algorithm, encoding) {
  return createHash(algorithm)
    .update(await readFile(filePath))
    .digest(encoding);
}

function validateProfilePlugin(plugin) {
  if (
    !plugin ||
    typeof plugin !== "object" ||
    typeof plugin.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(plugin.id) ||
    typeof plugin.packageName !== "string" ||
    !plugin.packageName
  ) {
    throw new Error(`bundle profile ${PROFILE_NAME} has invalid external plugin entry`);
  }
  return plugin;
}

function validatePackedPlugin({ expected, packageVersion, archivePath }) {
  const entries = new Set(listTarEntries(archivePath));
  const packageJson = JSON.parse(readTarEntry(archivePath, "package/package.json"));
  const manifest = JSON.parse(readTarEntry(archivePath, "package/openclaw.plugin.json"));
  if (packageJson.name !== expected.packageName || packageJson.version !== packageVersion) {
    throw new Error(
      `packed ${expected.id} identity mismatch: expected ${expected.packageName}@${packageVersion}, got ${packageJson.name}@${packageJson.version}`,
    );
  }
  if (manifest.id !== expected.id) {
    throw new Error(`packed ${expected.packageName} plugin id mismatch: ${manifest.id}`);
  }
  const runtimeExtensions = packageJson.openclaw?.runtimeExtensions;
  if (!Array.isArray(runtimeExtensions) || runtimeExtensions.length === 0) {
    throw new Error(`packed ${expected.packageName} lacks openclaw.runtimeExtensions`);
  }
  for (const runtimeEntry of runtimeExtensions) {
    const entry = `package/${String(runtimeEntry).replace(/^\.\//u, "")}`;
    if (!entries.has(entry)) {
      throw new Error(`packed ${expected.packageName} lacks runtime entry ${entry}`);
    }
  }
  const bundledDependencies = new Set(
    packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? [],
  );
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (!bundledDependencies.has(dependency)) {
      throw new Error(`packed ${expected.packageName} does not bundle dependency ${dependency}`);
    }
    const dependencyEntry = `package/node_modules/${dependency}/package.json`;
    if (!entries.has(dependencyEntry)) {
      throw new Error(`packed ${expected.packageName} lacks ${dependencyEntry}`);
    }
  }
}

async function removePriorArtifacts() {
  const prior = await readFile(OUT_MANIFEST, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  for (const plugin of prior?.plugins ?? []) {
    if (typeof plugin?.artifact === "string") {
      await rm(path.join(OUT_DIR, plugin.artifact), { force: true });
    }
  }
  await rm(OUT_MANIFEST, { force: true });
}

async function main() {
  const profile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
  const rootPackage = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const packageVersion = rootPackage.version;
  if (profile.profile !== PROFILE_NAME || typeof packageVersion !== "string" || !packageVersion) {
    throw new Error(`invalid ${PROFILE_NAME} profile or package version`);
  }
  if (!Array.isArray(profile.externalPlugins) || profile.externalPlugins.length === 0) {
    throw new Error(`bundle profile ${PROFILE_NAME} has no externalPlugins`);
  }
  const externalPlugins = profile.externalPlugins.map(validateProfilePlugin);
  await mkdir(OUT_DIR, { recursive: true });
  await removePriorArtifacts();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-external-plugins-"));
  try {
    const records = [];
    for (const plugin of externalPlugins) {
      const spec = `${plugin.packageName}@${packageVersion}`;
      const output = run(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", spec, "--json", "--ignore-scripts", "--pack-destination", tempDir],
        { cwd: tempDir },
      );
      const parsedOutput = JSON.parse(output);
      const packed = Array.isArray(parsedOutput) ? parsedOutput[0] : Object.values(parsedOutput)[0];
      if (
        packed?.name !== plugin.packageName ||
        packed?.version !== packageVersion ||
        typeof packed.filename !== "string" ||
        typeof packed.integrity !== "string" ||
        typeof packed.shasum !== "string"
      ) {
        throw new Error(`npm pack returned invalid identity metadata for ${spec}`);
      }
      const sourcePath = path.join(tempDir, packed.filename);
      validatePackedPlugin({ expected: plugin, packageVersion, archivePath: sourcePath });
      const artifact = `external-plugin-${plugin.id}.tgz`;
      const targetPath = path.join(OUT_DIR, artifact);
      await copyFile(sourcePath, targetPath);
      const integrity = `sha512-${await hashFile(targetPath, "sha512", "base64")}`;
      const shasum = await hashFile(targetPath, "sha1", "hex");
      if (integrity !== packed.integrity || shasum !== packed.shasum) {
        throw new Error(`npm pack digest metadata mismatch for ${spec}`);
      }
      records.push({
        id: plugin.id,
        packageName: plugin.packageName,
        version: packageVersion,
        spec,
        artifact,
        integrity,
        shasum,
        sha256: await hashFile(targetPath, "sha256", "hex"),
      });
    }
    records.sort((left, right) => left.id.localeCompare(right.id));
    await writeFile(
      OUT_MANIFEST,
      `${JSON.stringify({ schemaVersion: 1, plugins: records }, null, 2)}\n`,
    );
    process.stderr.write(`external plugins: ${records.map((plugin) => plugin.spec).join(", ")}\n`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`build-external-plugin-packages: ${error?.stack || error}\n`);
  process.exit(1);
});
