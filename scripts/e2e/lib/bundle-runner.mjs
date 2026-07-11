import { spawn } from "node:child_process";
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const DEFAULT_ASSET_DIR = path.join(OUT_DIR, "release-assets");

const DEFAULT_SIGNING_SECRET = "test-signing-secret-1234567890abcdef";
const DEFAULT_BOT_TOKEN = "xoxb-e2e-test-token";
const DEFAULT_GATEWAY_TOKEN = "bundle-e2e-gateway-token-1234567890";
const DEFAULT_TELEGRAM_BOT_TOKEN = "1234567890:bundle-telegram-e2e-token";
const DEFAULT_TELEGRAM_WEBHOOK_SECRET = "bundle-telegram-webhook-secret";
const DEFAULT_TELEGRAM_WEBHOOK_PATH = "/telegram-webhook";

// Stderr patterns that indicate the dual-load class of bug we want to catch
// before deploy. Matching any of these aborts the run with a precise message.
const FATAL_STDERR_PATTERNS = [
  "imported again after being required",
  "Status = 0",
  "Cannot find module",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "TypeError [ERR_REQUIRE_ESM]",
];

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("findFreePort: failed to obtain address"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAssetDir(explicitAssetDir) {
  if (explicitAssetDir) {
    return path.resolve(explicitAssetDir);
  }
  if (await fileExists(DEFAULT_ASSET_DIR)) {
    return DEFAULT_ASSET_DIR;
  }
  return OUT_DIR;
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

async function copyRequiredAsset(assetDir, tmpDir, fileName) {
  const source = path.join(assetDir, fileName);
  if (!(await fileExists(source))) {
    throw new Error(
      `bundle-runner: missing required release asset: ${path.relative(REPO_ROOT, source)}`,
    );
  }
  await copyFile(source, path.join(tmpDir, fileName));
}

async function extractTarball(cwd, fileName, targetDir = cwd) {
  await mkdir(targetDir, { recursive: true });
  await runChild("tar", ["-xzf", path.resolve(cwd, fileName)], {
    cwd: targetDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function requireStagedAsset(tmpDir, fileName, releaseTar) {
  if (!(await fileExists(path.join(tmpDir, fileName)))) {
    throw new Error(
      `bundle-runner: ${fileName} missing from extracted ${releaseTar}; rebuild release assets`,
    );
  }
}

async function stageBundle(tmpDir, { assetDir: explicitAssetDir } = {}) {
  const assetDir = await resolveAssetDir(explicitAssetDir);
  const releaseTar = await findReleaseTar(assetDir);
  if (releaseTar) {
    await copyRequiredAsset(assetDir, tmpDir, releaseTar);
    await extractTarball(tmpDir, releaseTar);
    for (const sidecar of [
      "openclaw.bundle.mjs",
      "bundle-deps.tar.gz",
      "bundle-openclaw-pkg.tar.gz",
      "channels.tar.gz",
      "runtime-plugins.tar.gz",
      "bundle-capabilities.json",
      "external-plugins.json",
    ]) {
      await requireStagedAsset(tmpDir, sidecar, releaseTar);
    }
  } else {
    for (const sidecar of [
      "openclaw.bundle.mjs",
      "bundle-deps.tar.gz",
      "bundle-openclaw-pkg.tar.gz",
      "channels.tar.gz",
      "runtime-plugins.tar.gz",
      "bundle-capabilities.json",
      "external-plugins.json",
    ]) {
      await copyRequiredAsset(assetDir, tmpDir, sidecar);
    }
  }

  for (const sidecar of ["bundle-deps.tar.gz", "bundle-openclaw-pkg.tar.gz"]) {
    await extractTarball(tmpDir, sidecar);
  }

  const extensionsDir = path.join(tmpDir, "extensions");
  await extractTarball(tmpDir, "channels.tar.gz", extensionsDir);
  await extractTarball(tmpDir, "runtime-plugins.tar.gz", extensionsDir);

  const externalPlugins = JSON.parse(
    await readFile(path.join(tmpDir, "external-plugins.json"), "utf8"),
  );
  if (externalPlugins.schemaVersion !== 1 || !Array.isArray(externalPlugins.plugins)) {
    throw new Error("bundle-runner: invalid external-plugins.json");
  }
  for (const plugin of externalPlugins.plugins) {
    if (releaseTar) {
      await requireStagedAsset(tmpDir, plugin.artifact, releaseTar);
    } else {
      await copyRequiredAsset(assetDir, tmpDir, plugin.artifact);
    }
  }

  const sharedChunks = path.join(tmpDir, "channel-shared-chunks.tar.gz");
  if (!(await fileExists(sharedChunks)) && !releaseTar) {
    const source = path.join(assetDir, "channel-shared-chunks.tar.gz");
    if (await fileExists(source)) {
      await copyFile(source, sharedChunks);
    }
  }
  if (await fileExists(sharedChunks)) {
    await extractTarball(tmpDir, "channel-shared-chunks.tar.gz");
  }
  return { assetDir, releaseTar, externalPlugins: externalPlugins.plugins };
}

async function writeCapabilityProbe(extensionsDir) {
  const pluginDir = path.join(extensionsDir, "bundle-capability-probe");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/bundle-capability-probe",
        version: "0.0.0",
        private: true,
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: "bundle-capability-probe",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(pluginDir, "index.js"),
    [
      'import { writeFile } from "node:fs/promises";',
      "export default {",
      '  id: "bundle-capability-probe",',
      '  name: "Bundle capability probe",',
      "  register(api) {",
      "    let resolveSeed;",
      "    let rejectSeed;",
      "    const seeded = new Promise((resolve, reject) => {",
      "      resolveSeed = resolve;",
      "      rejectSeed = reject;",
      "    });",
      '    api.on("gateway_start", async (_event, ctx) => {',
      "      try {",
      "        const cron = ctx.getCron?.();",
      '        if (!cron) throw new Error("cron service unavailable");',
      "        const add = async (name, enabled) => cron.add({",
      "          name,",
      '          description: "bundle reconciliation probe",',
      "          enabled,",
      '          schedule: { kind: "every", everyMs: 86400000 },',
      '          sessionTarget: "main",',
      '          wakeMode: "next-heartbeat",',
      '          payload: { kind: "systemEvent", text: name },',
      "        });",
      '        const enabledJob = await add("bundle-probe-enabled", true);',
      '        const disabledJob = await add("bundle-probe-disabled", false);',
      "        const ids = [enabledJob?.id, disabledJob?.id];",
      '        if (ids.some((id) => typeof id !== "string" || !id)) {',
      '          throw new Error("cron add did not return job ids");',
      "        }",
      "        resolveSeed(ids);",
      "      } catch (error) {",
      "        rejectSeed(error);",
      "        throw error;",
      "      }",
      "    });",
      '    api.on("cron_reconciled", async (event, ctx) => {',
      "      const markerPath = process.env.OPENCLAW_BUNDLE_CRON_PROBE_PATH;",
      '      if (!markerPath) throw new Error("missing cron probe path");',
      "      const seededIds = await seeded;",
      "      const jobs = await ctx.getCron?.()?.list({ includeDisabled: true }) ?? [];",
      '      await writeFile(markerPath, JSON.stringify({ event, jobs, seededIds }) + "\\n");',
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

function makeBundleConfig({
  signingSecret,
  botToken,
  gatewayToken,
  capabilityProbe,
  telegramApiUrl,
  telegramBotToken,
  telegramWebhookPort,
  telegramWebhookSecret,
  telegramWebhookPath,
}) {
  const telegramEnabled = Boolean(telegramApiUrl && telegramWebhookPort);
  return {
    gateway: {
      mode: "local",
      auth: { mode: "token", token: gatewayToken },
    },
    plugins: {
      entries: {
        slack: { enabled: true },
        "admin-http-rpc": { enabled: true },
        ...(telegramEnabled ? { telegram: { enabled: true } } : {}),
        ...(capabilityProbe ? { "bundle-capability-probe": { enabled: true } } : {}),
      },
    },
    channels: {
      slack: {
        accounts: {
          default: {
            mode: "http",
            enabled: true,
            signingSecret,
            botToken,
            // Force HTTP-only mode so socket-mode handshake doesn't run.
            // appToken intentionally omitted.
          },
        },
      },
      ...(telegramEnabled
        ? {
            telegram: {
              accounts: {
                default: {
                  enabled: true,
                  botToken: telegramBotToken,
                  apiRoot: telegramApiUrl,
                  webhookUrl: `http://127.0.0.1:${telegramWebhookPort}${telegramWebhookPath}`,
                  webhookSecret: telegramWebhookSecret,
                  webhookHost: "127.0.0.1",
                  webhookPort: telegramWebhookPort,
                  webhookPath: telegramWebhookPath,
                },
              },
            },
          }
        : {}),
    },
  };
}

async function waitForReady({ port, timeoutMs = 45_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  // /healthz is the liveness probe — returns 200 once the HTTP server is bound.
  // /ready waits on every channel to be connected, which a fake slack token
  // can never satisfy; for L2/L3 boot smoke, liveness is the right signal.
  const url = `http://127.0.0.1:${port}/healthz`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch {
      // gateway not listening yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`bundle-runner: gateway not live after ${timeoutMs}ms (port ${port})`);
}

export async function runBundle({
  extraEnv = {},
  signingSecret = DEFAULT_SIGNING_SECRET,
  botToken = DEFAULT_BOT_TOKEN,
  gatewayToken = DEFAULT_GATEWAY_TOKEN,
  capabilityProbe = false,
  slackApiUrl,
  telegramApiUrl,
  telegramBotToken = DEFAULT_TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret = DEFAULT_TELEGRAM_WEBHOOK_SECRET,
  telegramWebhookPath = DEFAULT_TELEGRAM_WEBHOOK_PATH,
  assetDir,
  port,
  readyTimeoutMs = 45_000,
} = {}) {
  const rawTmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-e2e-"));
  // macOS resolves /var → /private/var. Node's ESM module cache keys by URL,
  // so loading the same file via both /var and /private/var URLs produces two
  // distinct module instances. Realpath the staging dir up front so every
  // path the bundle ever sees is canonical and the slack runtime registry
  // singleton stays singular.
  let tmpDir;
  try {
    tmpDir = fs.realpathSync.native(rawTmpDir);
  } catch {
    tmpDir = rawTmpDir;
  }
  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(homeDir, ".openclaw");
  const configPath = path.join(stateDir, "config.json");
  await mkdir(stateDir, { recursive: true });

  const stagedBundle = await stageBundle(tmpDir, { assetDir });
  const extensionsDir = path.join(tmpDir, "extensions");
  const cronProbePath = path.join(tmpDir, "cron-reconciled.json");
  if (capabilityProbe) {
    await writeCapabilityProbe(extensionsDir);
  }
  const telegramWebhookPort = telegramApiUrl ? await findFreePort() : null;

  await writeFile(
    configPath,
    `${JSON.stringify(
      makeBundleConfig({
        signingSecret,
        botToken,
        gatewayToken,
        capabilityProbe,
        telegramApiUrl,
        telegramBotToken,
        telegramWebhookPort,
        telegramWebhookSecret,
        telegramWebhookPath,
      }),
      null,
      2,
    )}\n`,
  );

  for (const plugin of stagedBundle.externalPlugins) {
    await runChild(
      process.execPath,
      [
        "openclaw.bundle.mjs",
        "plugins",
        "install",
        `npm-pack:${path.join(tmpDir, plugin.artifact)}`,
      ],
      {
        cwd: tmpDir,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "production",
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_BUNDLE_PROFILE: "sandbox",
          OPENCLAW_BUNDLED_PLUGINS_DIR: extensionsDir,
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_offline: "true",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
  }

  const resolvedPort = port ?? (await findFreePort());

  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLE_PROFILE: "sandbox",
    OPENCLAW_BUNDLED_PLUGINS_DIR: extensionsDir,
    ...(capabilityProbe ? { OPENCLAW_BUNDLE_CRON_PROBE_PATH: cronProbePath } : {}),
    // Disable any startup probes that might block on outbound network.
    OPENCLAW_DISABLE_TELEMETRY: "1",
    OPENCLAW_E2E_VERBOSE_ERRORS: "1",
    // Set OPENCLAW_E2E_NODE_DEBUG=1 to layer Node's module/esm loader trace
    // on top of the bundle output when chasing a dual-load.
    ...(process.env.OPENCLAW_E2E_NODE_DEBUG === "1"
      ? {
          NODE_DEBUG: "module,esm",
          NODE_OPTIONS: "--enable-source-maps --stack-trace-limit=200",
        }
      : {}),
    ...(slackApiUrl ? { OPENCLAW_SLACK_API_URL_OVERRIDE: slackApiUrl } : {}),
    ...extraEnv,
  };

  const stdoutChunks = [];
  const stderrChunks = [];
  let dualLoadHit = null;
  let resolveFatal;
  const fatalPromise = new Promise((resolve) => {
    resolveFatal = resolve;
  });

  const child = spawn(
    process.execPath,
    ["openclaw.bundle.mjs", "gateway", "run", "--bind", "loopback", "--port", String(resolvedPort)],
    {
      cwd: tmpDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const watchStream = (stream, chunks) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      if (!dualLoadHit) {
        const matched = FATAL_STDERR_PATTERNS.find((needle) => text.includes(needle));
        if (matched) {
          dualLoadHit = matched;
          resolveFatal(matched);
        }
      }
    });
  };
  watchStream(child.stdout, stdoutChunks);
  watchStream(child.stderr, stderrChunks);

  let exited = false;
  let exitInfo;
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  const ready = await Promise.race([
    waitForReady({ port: resolvedPort, timeoutMs: readyTimeoutMs }).then(() => ({
      type: "ready",
    })),
    fatalPromise.then((needle) => ({ type: "fatal", needle })),
  ]).catch((err) => ({ type: "error", err }));

  if (ready.type !== "ready") {
    if (!exited) {
      child.kill("SIGKILL");
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (ready.type === "fatal") {
      const error = new Error(
        `bundle-runner: fatal stderr pattern detected before ready: "${ready.needle}"`,
      );
      error.stderr = stderrChunks.join("");
      error.stdout = stdoutChunks.join("");
      throw error;
    }
    if (ready.type === "error") {
      const error = new Error(`bundle-runner: ${ready.err.message}`);
      error.stderr = stderrChunks.join("");
      error.stdout = stdoutChunks.join("");
      error.cause = ready.err;
      throw error;
    }
  }

  return {
    port: resolvedPort,
    url: `http://127.0.0.1:${resolvedPort}`,
    tmpDir,
    homeDir,
    configPath,
    assetDir: stagedBundle.assetDir,
    releaseTar: stagedBundle.releaseTar,
    signingSecret,
    botToken,
    gatewayToken,
    telegramBotToken: telegramApiUrl ? telegramBotToken : null,
    telegramWebhookSecret: telegramApiUrl ? telegramWebhookSecret : null,
    telegramWebhookUrl: telegramWebhookPort
      ? `http://127.0.0.1:${telegramWebhookPort}${telegramWebhookPath}`
      : null,
    cronProbePath: capabilityProbe ? cronProbePath : null,
    pid: child.pid,
    isDualLoadHit: () => dualLoadHit,
    getStderr: () => stderrChunks.join(""),
    getStdout: () => stdoutChunks.join(""),
    waitExit: () =>
      new Promise((resolve) => {
        if (exited) {
          resolve(exitInfo);
          return;
        }
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
    stop: async () => {
      if (!exited) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (!exited) {
          child.kill("SIGKILL");
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
      if (process.env.OPENCLAW_E2E_KEEP_TMP === "1") {
        process.stderr.write(`[bundle-runner] keeping tmpDir=${tmpDir}\n`);
        return;
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
