#!/usr/bin/env node
/**
 * One-shot ESM bundle builder for openclaw.
 * Produces dist/sandbox/openclaw.bundle.mjs
 *
 * Key difference from the CJS builder: uses format: 'esm' to support
 * top-level await in dist/entry.js, and injects a createRequire shim
 * so CJS deps (like `debug`) that call require("tty") still work.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { pluginSdkSubpaths as publicPluginSdkSubpaths } from "./lib/plugin-sdk-entries.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "entry.js");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const OUT_FILE = path.join(OUT_DIR, "openclaw.bundle.mjs");
const DEPS_OUT_FILE = path.join(OUT_DIR, "bundle-deps.tar.gz");
const OPENCLAW_PKG_OUT_FILE = path.join(OUT_DIR, "bundle-openclaw-pkg.tar.gz");
const RELEASE_TAR_OUT_FILE = path.join(OUT_DIR, "openclaw-release.tar.gz");
const RELEASE_TAR_REQUIRED_FILES = [
  "openclaw.bundle.mjs",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "release.json",
  "bundle-contract.json",
];
const RELEASE_TAR_OPTIONAL_FILES = ["channel-shared-chunks.tar.gz", "asset-manifest.json"];
const DIST_EXTENSIONS_DIR = path.join(REPO_ROOT, "dist", "extensions");
const SRC_PLUGIN_SDK_DIR = path.join(REPO_ROOT, "src", "plugin-sdk");
const DISABLED_STUB_REGISTRY_FILE = path.join(SRC_PLUGIN_SDK_DIR, "disabled-stubs", "registry.ts");
const PLUGIN_SDK_IMPORT_PATTERN =
  /(?:from\s+["']openclaw\/plugin-sdk\/([^"']+)["']|import\s+["']openclaw\/plugin-sdk\/([^"']+)["'])/g;
const BUNDLED_PLUGIN_SDK_EXCLUDED_SUBPATHS = new Set([
  "agent-runtime-test-contracts",
  "channel-contract-testing",
  "channel-target-testing",
  "channel-test-helpers",
  "plugin-test-api",
  "plugin-test-contracts",
  "plugin-test-runtime",
  "provider-http-test-mocks",
  "provider-test-contracts",
  "test-env",
  "test-fixtures",
  "test-node-mocks",
  "testing",
]);
const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const PROFILE_NAME = process.env.OPENCLAW_BUNDLE_PROFILE ?? "sandbox";
const PROFILE_PATH = path.join(REPO_ROOT, ".fork", `bundle-profile.${PROFILE_NAME}.json`);

const log = (...parts) => process.stderr.write(parts.join(" ") + "\n");

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `missing bundle profile manifest for ${PROFILE_NAME}: ${path.relative(REPO_ROOT, filePath)}`,
        { cause: err },
      );
    }
    throw err;
  }
}

function assertStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`bundle profile ${PROFILE_NAME} has invalid ${fieldName}`);
  }
  return value;
}

function assertObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`bundle profile ${PROFILE_NAME} has invalid ${fieldName}`);
  }
  return value;
}

async function loadBundleProfile() {
  const manifest = await readJson(PROFILE_PATH);
  if (manifest.profile !== PROFILE_NAME) {
    throw new Error(
      `bundle profile manifest mismatch: expected ${PROFILE_NAME}, got ${JSON.stringify(manifest.profile)}`,
    );
  }
  assertObject(manifest.disabledOptionalNativeModules, "disabledOptionalNativeModules");
  assertStringArray(manifest.externalRuntimeDeps, "externalRuntimeDeps");
  if (!Array.isArray(manifest.disabledPublicSurfaces)) {
    throw new Error(`bundle profile ${PROFILE_NAME} has invalid disabledPublicSurfaces`);
  }
  assertObject(manifest.budgets, "budgets");
  return manifest;
}

function resolveRepoPath(relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`bundle profile paths must be repo-relative: ${relativePath}`);
  }
  return path.join(REPO_ROOT, relativePath);
}

function disabledSurfaceKey(surface) {
  if (!surface || typeof surface !== "object") {
    return null;
  }
  const { dirName, artifactBasename } = surface;
  if (
    typeof dirName !== "string" ||
    !dirName ||
    typeof artifactBasename !== "string" ||
    !artifactBasename
  ) {
    return null;
  }
  return `${dirName}/${artifactBasename}`;
}

async function assertDisabledPublicSurfaceManifest(manifest) {
  const source = await readFile(DISABLED_STUB_REGISTRY_FILE, "utf8");
  const registryEntries = new Set();
  for (const match of source.matchAll(/["']([^"']+\/[^"']+)["']\s*:/g)) {
    registryEntries.add(match[1]);
  }
  const declaredEntries = new Set();
  for (const surface of manifest.disabledPublicSurfaces) {
    const key = disabledSurfaceKey(surface);
    if (!key) {
      throw new Error(`bundle profile ${PROFILE_NAME} has invalid disabledPublicSurfaces entry`);
    }
    declaredEntries.add(key);
  }
  const undeclared = [...registryEntries].filter((key) => !declaredEntries.has(key));
  if (undeclared.length > 0) {
    throw new Error(
      `bundle profile ${PROFILE_NAME} is missing disabledPublicSurfaces entries for disabled stub surface(s): ${undeclared.join(", ")}`,
    );
  }
}

function createDisabledOptionalAliasMap(manifest) {
  return Object.fromEntries(
    Object.entries(manifest.disabledOptionalNativeModules).map(([moduleName, stubPath]) => {
      if (typeof stubPath !== "string" || !stubPath) {
        throw new Error(
          `bundle profile ${PROFILE_NAME} has invalid disabled optional stub for ${moduleName}`,
        );
      }
      return [moduleName, resolveRepoPath(stubPath)];
    }),
  );
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
  const value = result.stdout.trim();
  return value || null;
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function resolveEsbuildLoader(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    return "ts";
  }
  return "js";
}

const createRequireRewritePlugin = {
  name: "openclaw-createrequire-inline",
  setup(build) {
    build.onLoad({ filter: /\.(m?js|cjs|ts|mts|cts)$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) {
        return null;
      }
      const source = await readFile(args.path, "utf8");
      if (!source.includes("createRequire(import.meta.url)")) {
        return null;
      }
      let rewritten = source.replace(
        /createRequire\(import\.meta\.url\)\(("[^"]+"|'[^']+')\)/g,
        "require($1)",
      );

      // Collect literal `./*.runtime.{js,ts}` candidates referenced in this
      // file. These are the modules that callers will pass as variables to a
      // dynamic require, and esbuild can't see those dynamic calls.
      // Only collect .js candidates — esbuild is bundling already-compiled
      // dist/*.js output, so .ts candidates are unresolvable runtime fallbacks
      // (used only by jiti dev paths). Including them produces resolve errors.
      const runtimeCandidatePattern = /["']\.\/[\w./-]+\.runtime\.js["']/g;
      const candidates = new Set();
      for (const match of rewritten.matchAll(runtimeCandidatePattern)) {
        candidates.add(match[0].slice(1, -1));
      }

      // Rewrite `const X = createRequire(import.meta.url)`:
      // - If X === "require": delete (banner already provides require).
      // - If we have known runtime candidates: replace with a switch wrapper
      //   that calls static `require("./literal")` for each known candidate so
      //   esbuild bundles them and the dynamic `X(candidate)` call resolves
      //   through the bundle's module map at runtime.
      // - Otherwise: alias X to the banner's require.
      rewritten = rewritten.replace(
        /((?:const|let|var)\s+)([\w$]+)(\s*=\s*)createRequire\(import\.meta\.url\)(?!\()(;\n?)/g,
        (_match, decl, name, eq, end) => {
          if (name === "require") {
            return "";
          }
          if (candidates.size > 0) {
            const cases = Array.from(candidates)
              .map((c) => `case ${JSON.stringify(c)}:return require(${JSON.stringify(c)});`)
              .join("");
            return `${decl}${name}${eq}((__c)=>{switch(__c){${cases}default:return require(__c);}})${end}`;
          }
          return `${decl}${name}${eq}require${end}`;
        },
      );

      // Belt-and-suspenders: also append top-level static requires so esbuild
      // bundles the runtime modules even if the createRequire pattern wasn't
      // matched (e.g. a callsite that constructs require some other way).
      if (candidates.size > 0) {
        const stub = Array.from(candidates)
          .map((c) => `try{require(${JSON.stringify(c)});}catch{}`)
          .join("");
        rewritten += `\n;(()=>{${stub}})();\n`;
      }
      return rewritten === source
        ? null
        : { contents: rewritten, loader: resolveEsbuildLoader(args.path) };
    });
  },
};

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, {
      cwd,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
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

function listTar(args, cwd) {
  const result = spawnSync("tar", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} exited with code ${result.status ?? result.signal}`);
  }
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

async function walkFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function collectPluginSdkSubpathsUsedByBundledExtensions() {
  const subpaths = new Set();
  for (const file of await walkFiles(DIST_EXTENSIONS_DIR)) {
    if (!/\.(?:mjs|cjs|js)$/u.test(file)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(PLUGIN_SDK_IMPORT_PATTERN)) {
      const subpath = match[1] ?? match[2];
      if (subpath) {
        subpaths.add(subpath);
      }
    }
  }

  if (subpaths.size === 0) {
    for (const subpath of publicPluginSdkSubpaths) {
      if (!BUNDLED_PLUGIN_SDK_EXCLUDED_SUBPATHS.has(subpath)) {
        subpaths.add(subpath);
      }
    }
  }

  return [...subpaths].toSorted((left, right) => left.localeCompare(right));
}

function stripJavaScriptComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function packageNameFromBareSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.includes(":")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function addInstalledPackageDependencyClosure(runtimeDeps, packageName) {
  if (!packageName || NODE_BUILTIN_MODULES.has(packageName)) {
    return;
  }
  const packageJsonPath = path.join(REPO_ROOT, "node_modules", packageName, "package.json");
  const pkg = await readFile(packageJsonPath, "utf8")
    .then((source) => JSON.parse(source))
    .catch(() => null);
  if (!pkg) {
    return;
  }

  const wasPresent = runtimeDeps.has(packageName);
  runtimeDeps.add(packageName);
  if (wasPresent) {
    return;
  }

  const dependencyNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
  for (const dependencyName of dependencyNames) {
    await addInstalledPackageDependencyClosure(runtimeDeps, dependencyName);
  }
}

async function collectNestedInstalledPackageDependencies(runtimeDeps) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const packageName of runtimeDeps) {
      const packageRoot = path.join(REPO_ROOT, "node_modules", packageName);
      for (const packageJsonPath of await walkFiles(packageRoot)) {
        if (path.basename(packageJsonPath) !== "package.json") {
          continue;
        }
        const pkg = await readFile(packageJsonPath, "utf8")
          .then((source) => JSON.parse(source))
          .catch(() => null);
        if (!pkg) {
          continue;
        }
        const dependencyNames = [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.optionalDependencies ?? {}),
        ];
        for (const dependencyName of dependencyNames) {
          const beforeSize = runtimeDeps.size;
          await addInstalledPackageDependencyClosure(runtimeDeps, dependencyName);
          if (runtimeDeps.size !== beforeSize) {
            changed = true;
          }
        }
      }
    }
  }
}

async function collectChannelSharedChunkRuntimeDeps(baseRuntimeDeps) {
  const runtimeDeps = new Set();
  const importPattern =
    /(?:^|[;\n])\s*(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const dep of baseRuntimeDeps) {
    await addInstalledPackageDependencyClosure(runtimeDeps, dep);
  }

  for (const file of await walkFiles(path.join(REPO_ROOT, "dist"))) {
    if (path.relative(path.join(REPO_ROOT, "dist"), file).includes(path.sep)) {
      continue;
    }
    if (!file.endsWith(".js")) {
      continue;
    }
    const source = stripJavaScriptComments(await readFile(file, "utf8"));
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || NODE_BUILTIN_MODULES.has(specifier)) {
        continue;
      }
      const packageName = packageNameFromBareSpecifier(specifier);
      if (packageName) {
        await addInstalledPackageDependencyClosure(runtimeDeps, packageName);
      }
    }
  }

  await collectNestedInstalledPackageDependencies(runtimeDeps);

  return [...runtimeDeps].toSorted((left, right) => left.localeCompare(right));
}

function toIdentifierSuffix(value) {
  return value.replace(/[^a-zA-Z0-9_$]/g, "_");
}

function parseExportedRuntimeNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}(?:\s*from\s*["'][^"']+["'])?/g)) {
    const before = source.slice(Math.max(0, match.index - 12), match.index);
    if (/export\s+type\s*$/u.test(before)) {
      continue;
    }
    const body = match[1] ?? "";
    for (const rawPart of body.split(",")) {
      const part = rawPart.trim();
      if (!part || part.startsWith("type ")) {
        continue;
      }
      const aliasMatch = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(part);
      const directMatch = /^([A-Za-z_$][\w$]*)$/u.exec(part);
      const name = aliasMatch?.[1] ?? directMatch?.[1];
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

async function collectPluginSdkRuntimeExportNames(subpath) {
  const builtPath = path.join(REPO_ROOT, "dist", "plugin-sdk", `${subpath}.js`);
  const sourcePath = path.join(SRC_PLUGIN_SDK_DIR, `${subpath}.ts`);
  const builtSource = await readFile(builtPath, "utf8").catch(() => null);
  if (builtSource) {
    const builtNames = parseExportedRuntimeNames(builtSource);
    if (builtNames.length > 0) {
      return builtNames;
    }
  }
  const source = await readFile(sourcePath, "utf8");
  return parseExportedRuntimeNames(source);
}

async function writeBundleEntryWrapper(subpaths) {
  const wrapperDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bundle-entry-"));
  const wrapperPath = path.join(wrapperDir, "entry.mjs");
  const lines = [
    `import { loadOpenClawPlugins } from ${JSON.stringify(path.join(REPO_ROOT, "src", "plugins", "loader.ts"))};`,
    "const __openclawBundlePluginSdkRegistry = {};",
  ];
  subpaths.forEach((subpath, index) => {
    const ident = `sdk_${index}_${toIdentifierSuffix(subpath)}`;
    const target = path.join(SRC_PLUGIN_SDK_DIR, `${subpath}.ts`);
    lines.unshift(`import * as ${ident} from ${JSON.stringify(target)};`);
    lines.push(`__openclawBundlePluginSdkRegistry[${JSON.stringify(subpath)}] = ${ident};`);
  });
  lines.push(
    "globalThis.__OPENCLAW_BUNDLE_PLUGIN_SDK_REGISTRY__ = __openclawBundlePluginSdkRegistry;",
    'if (process.env.OPENCLAW_BUNDLE_SMOKE === "1") {',
    "  try {",
    '    const registry = loadOpenClawPlugins({ mode: "validate", activate: false, cache: false, loadModules: true, throwOnLoadError: true });',
    "    const pluginIds = registry.plugins.map((plugin) => plugin.id).sort();",
    "    console.log(`[bundle-smoke] ${JSON.stringify({ ok: true, pluginCount: registry.plugins.length, pluginIds, errorCount: 0 })}`);",
    "    process.exit(0);",
    "  } catch (err) {",
    "    const message = err instanceof Error ? err.message : String(err);",
    "    console.log(`[bundle-smoke] ${JSON.stringify({ ok: false, error: message })}`);",
    "    process.exit(1);",
    "  }",
    "}",
    "if (process.env.OPENCLAW_BUNDLE_PUBLIC_SURFACE_SMOKE) {",
    "  try {",
    "    const specs = JSON.parse(process.env.OPENCLAW_BUNDLE_PUBLIC_SURFACE_SMOKE);",
    "    const results = [];",
    "    for (const spec of specs) {",
    '      const mod = await import("openclaw/plugin-sdk/tts-runtime");',
    '      const result = { dirName: spec.dirName, artifactBasename: spec.artifactBasename, sdkSubpath: "tts-runtime", exportCount: Object.keys(mod).length };',
    '      if (typeof mod.isTtsEnabled === "function") result.isTtsEnabled = mod.isTtsEnabled();',
    "      results.push(result);",
    "    }",
    '    console.log("[bundle-public-surface-smoke] " + JSON.stringify({ ok: true, results }));',
    "    process.exit(0);",
    "  } catch (err) {",
    "    const message = err instanceof Error ? err.message : String(err);",
    '    console.log("[bundle-public-surface-smoke] " + JSON.stringify({ ok: false, error: message }));',
    "    process.exit(1);",
    "  }",
    "}",
    `await import(${JSON.stringify(DIST_ENTRY)});`,
  );
  await writeFile(wrapperPath, `${lines.join("\n")}\n`);
  return { wrapperDir, wrapperPath };
}

async function writeOpenClawPackageSidecar(subpaths) {
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bundle-pkg-"));
  const packageRoot = path.join(stagingRoot, "node_modules", "openclaw");
  const pluginSdkRoot = path.join(packageRoot, "plugin-sdk");
  await mkdir(pluginSdkRoot, { recursive: true });

  const exportsField = {};
  for (const subpath of subpaths) {
    exportsField[`./plugin-sdk/${subpath}`] = `./plugin-sdk/${subpath}.cjs`;
    const shimPath = path.join(pluginSdkRoot, `${subpath}.cjs`);
    await mkdir(path.dirname(shimPath), { recursive: true });
    const exportNames = await collectPluginSdkRuntimeExportNames(subpath);
    await writeFile(
      shimPath,
      [
        "'use strict';",
        "const registry = globalThis.__OPENCLAW_BUNDLE_PLUGIN_SDK_REGISTRY__;",
        `const mod = registry && registry[${JSON.stringify(subpath)}];`,
        "if (!mod) {",
        `  throw new Error(${JSON.stringify(`OpenClaw bundle SDK registry is missing plugin-sdk/${subpath}`)});`,
        "}",
        "module.exports = mod;",
        ...exportNames.map((name) => `exports.${name} = mod.${name};`),
        "",
      ].join("\n"),
    );
  }

  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: "openclaw",
        type: "commonjs",
        exports: exportsField,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(stagingRoot, "package.json"),
    JSON.stringify(
      { name: "openclaw-sandbox-bundle-runtime", private: true, version: "0.0.0" },
      null,
      2,
    ) + "\n",
  );
  await runTar(
    ["-czhf", OPENCLAW_PKG_OUT_FILE, "package.json", "node_modules/openclaw"],
    stagingRoot,
  );
  await rm(stagingRoot, { recursive: true, force: true });
}

async function writeBundleContract({
  manifest,
  version,
  pluginSdkSubpaths,
  runtimeDeps,
  outputSizes,
}) {
  await writeFile(
    path.join(OUT_DIR, "bundle-contract.json"),
    JSON.stringify(
      {
        profile: manifest.profile,
        packageVersion: version,
        pluginSdkSubpaths,
        disabledPublicSurfaces: manifest.disabledPublicSurfaces,
        externalRuntimeDeps: runtimeDeps,
        disabledOptionalNativeModules: manifest.disabledOptionalNativeModules,
        outputs: {
          bundle: { path: "openclaw.bundle.mjs", bytes: outputSizes.bundle },
          depsTar: { path: "bundle-deps.tar.gz", bytes: outputSizes.depsTar },
          openclawTar: { path: "bundle-openclaw-pkg.tar.gz", bytes: outputSizes.openclawTar },
          releaseTar: { path: "openclaw-release.tar.gz", bytes: outputSizes.releaseTar },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

async function resolveReleaseTarFiles() {
  for (const fileName of RELEASE_TAR_REQUIRED_FILES) {
    if (!(await stat(path.join(OUT_DIR, fileName)).catch(() => null))) {
      throw new Error(
        `missing required release tarball input: ${path.relative(REPO_ROOT, path.join(OUT_DIR, fileName))}`,
      );
    }
  }
  const optionalFiles = [];
  for (const fileName of RELEASE_TAR_OPTIONAL_FILES) {
    if (await stat(path.join(OUT_DIR, fileName)).catch(() => null)) {
      optionalFiles.push(fileName);
    }
  }
  return [...RELEASE_TAR_REQUIRED_FILES, ...optionalFiles];
}

async function createReleaseTarball() {
  const releaseTarFiles = await resolveReleaseTarFiles();
  await runTar(["-czf", RELEASE_TAR_OUT_FILE, ...releaseTarFiles], OUT_DIR);
  return stat(RELEASE_TAR_OUT_FILE);
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = await loadBundleProfile();
  await assertDisabledPublicSurfaceManifest(manifest);
  const runtimeDeps = await collectChannelSharedChunkRuntimeDeps(manifest.externalRuntimeDeps);
  const disabledOptionalAliases = createDisabledOptionalAliasMap(manifest);

  if (!(await stat(DIST_ENTRY).catch(() => null))) {
    throw new Error(`missing dist/entry.js — run pnpm build first`);
  }
  if (!(await stat(DIST_EXTENSIONS_DIR).catch(() => null))) {
    throw new Error(`missing dist/extensions — run pnpm build first`);
  }

  // Stamp the bundle with the package version so src/version.ts resolves the
  // host version (it falls back to "0.0.0" otherwise, which makes plugins'
  // engines.openclaw gating reject every plugin at runtime).
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const VERSION = pkg.version;
  if (typeof VERSION !== "string" || VERSION.length === 0) {
    throw new Error("package.json is missing a version field");
  }
  log(`stamping bundle as OpenClaw ${VERSION}`);

  const { build } = await import("esbuild");
  log(`bundling ESM via esbuild for ${manifest.profile}...`);
  const pluginSdkSubpaths = await collectPluginSdkSubpathsUsedByBundledExtensions();
  if (pluginSdkSubpaths.length === 0) {
    throw new Error("no openclaw/plugin-sdk imports found in dist/extensions");
  }
  log(`registering ${pluginSdkSubpaths.length} plugin-sdk subpaths for bundled extensions`);
  const { wrapperDir, wrapperPath } = await writeBundleEntryWrapper(pluginSdkSubpaths);

  // Banner: inject createRequire so CJS modules that call require("tty")
  // etc. still work inside the ESM bundle.
  const banner = [
    'import { createRequire as __openclaw_createRequire } from "node:module";',
    "const require = __openclaw_createRequire(import.meta.url);",
  ].join("\n");

  let result;
  try {
    result = await build({
      entryPoints: [wrapperPath],
      outfile: OUT_FILE,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      packages: "bundle",
      mainFields: ["module", "main"],
      resolveExtensions: [".js", ".mjs", ".cjs", ".json"],
      minifySyntax: true,
      minifyWhitespace: true,
      keepNames: true,
      legalComments: "none",
      metafile: true,
      logLevel: "warning",
      banner: { js: banner },
      define: {
        __OPENCLAW_VERSION__: JSON.stringify(VERSION),
      },
      alias: disabledOptionalAliases,
      external: [
        "fsevents",
        "@img/sharp-*",
        "@node-llama-cpp/*",
        "node-llama-cpp",
        ...manifest.externalRuntimeDeps,
      ],
      plugins: [createRequireRewritePlugin],
    });
  } finally {
    await rm(wrapperDir, { recursive: true, force: true });
  }

  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify(result.metafile, null, 2));

  const outStat = await stat(OUT_FILE);
  log(`\nbundle: ${path.relative(REPO_ROOT, OUT_FILE)}`);
  log(`  size: ${(outStat.size / (1024 * 1024)).toFixed(2)} MB`);

  // Pack node_modules/<dep> for each external runtime dep so the consumer
  // can extract them next to openclaw.bundle.mjs and let createRequire
  // resolve them.
  for (const dep of runtimeDeps) {
    const depPath = path.join(REPO_ROOT, "node_modules", dep);
    if (!(await stat(depPath).catch(() => null))) {
      throw new Error(`missing node_modules/${dep} — run pnpm install before building the bundle`);
    }
  }
  const tarPaths = runtimeDeps.map((dep) => `node_modules/${dep}`);
  await runTar(["-czhf", DEPS_OUT_FILE, ...tarPaths], REPO_ROOT);
  const depsStat = await stat(DEPS_OUT_FILE);
  log(`\ndeps:   ${path.relative(REPO_ROOT, DEPS_OUT_FILE)}`);
  log(`  size: ${(depsStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log(`  contains: ${runtimeDeps.join(", ")}`);

  await writeOpenClawPackageSidecar(pluginSdkSubpaths);
  const openclawPkgStat = await stat(OPENCLAW_PKG_OUT_FILE);
  log(`\nopenclaw pkg: ${path.relative(REPO_ROOT, OPENCLAW_PKG_OUT_FILE)}`);
  log(`  size: ${(openclawPkgStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log(`  plugin-sdk shims: ${pluginSdkSubpaths.length}`);

  await writeFile(
    path.join(OUT_DIR, "release.json"),
    JSON.stringify(
      {
        profile: manifest.profile,
        upstreamSha: gitRevParse("upstream/main"),
        forkSha: gitRevParse("HEAD"),
        bundleSha256: await sha256File(OUT_FILE),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  let releaseTarSize = 0;
  let releaseTarStat;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await writeBundleContract({
      manifest,
      version: VERSION,
      pluginSdkSubpaths,
      runtimeDeps,
      outputSizes: {
        bundle: outStat.size,
        depsTar: depsStat.size,
        openclawTar: openclawPkgStat.size,
        releaseTar: releaseTarSize,
      },
    });
    releaseTarStat = await createReleaseTarball();
    if (releaseTarStat.size === releaseTarSize) {
      break;
    }
    releaseTarSize = releaseTarStat.size;
  }
  if (!releaseTarStat || releaseTarStat.size !== releaseTarSize) {
    throw new Error("release tarball size did not stabilize while writing bundle-contract.json");
  }
  const tarEntries = listTar(["-tzf", RELEASE_TAR_OUT_FILE], OUT_DIR);
  log(`\nrelease: openclaw-release.tar.gz`);
  log(`  size: ${(releaseTarStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log(`  contains: ${tarEntries.join(", ")}`);
  log("done.");
};

main().catch((err) => {
  process.stderr.write(`build-bundle-esm: ${err?.stack || err}\n`);
  process.exit(1);
});
