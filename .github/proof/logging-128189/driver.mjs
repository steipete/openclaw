import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [mode, sourceDir, proofDir, arm, sizeArg, countArg] = process.argv.slice(2);
assert.ok(mode === "compare" || mode === "worker");
assert.ok(mode === "compare" || arm === "baseline" || arm === "candidate");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const save = (name, value) =>
  fs.writeFileSync(path.join(proofDir, name), `${JSON.stringify(value, null, 2)}\n`);

if (mode === "worker") {
  const size = Number(sizeArg);
  const count = Number(countArg);
  assert.ok([8_192, 40_960, 131_072].includes(size));
  assert.ok(count === 64 || count === 128);
  const metadata = {
    name: "fixture-package-0000",
    version: "1.0.0",
    keywords: ["build", "metadata"],
    author: "Synthetic Fixture",
  };
  const packageCount = Math.ceil(size / (JSON.stringify(metadata).length + 1));
  const packages = Array.from({ length: packageCount }, (_, index) => ({
    ...metadata,
    name: `fixture-package-${String(index).padStart(4, "0")}`,
  }));
  const message = JSON.stringify({ packages });
  const file = path.join(proofDir, "ordinary.log");
  const { applyLoggingConfig, flushLogger, getResolvedLoggerSettings } = await import(
    pathToFileURL(path.join(sourceDir, "src/logging/logger.ts")).href
  );
  const { createSubsystemLogger } = await import(
    pathToFileURL(path.join(sourceDir, "src/logging/subsystem.ts")).href
  );
  applyLoggingConfig({
    level: "info",
    consoleLevel: "silent",
    file,
    maxFileBytes: 64 * 1024 * 1024,
  });
  const settings = getResolvedLoggerSettings();
  assert.equal(settings.file, file);
  assert.equal(settings.level, "info");
  const logger = createSubsystemLogger("logging-proof");
  logger.info(message, { sequence: -1 });
  await flushLogger();
  const started = performance.now();
  const cpu = process.cpuUsage();
  for (let sequence = 0; sequence < count; sequence += 1) {
    logger.info(message, { sequence });
  }
  await flushLogger();
  const elapsedMs = performance.now() - started;
  const cpuMicros = process.cpuUsage(cpu);
  const peakRssKiB = process.resourceUsage().maxRSS;
  // Read back original arguments, not only the intentionally capped message projection.
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, count + 1);
  const normalized = lines.map((line, index) => {
    const record = JSON.parse(line);
    const numeric = Object.entries(record)
      .filter(([key]) => /^\d+$/.test(key))
      .map(([, value]) => value);
    assert.ok(numeric.includes(message), "complete ordinary message missing or altered");
    assert.ok(
      numeric.some((value) => value && typeof value === "object" && value.sequence === index - 1),
    );
    assert.equal(record._meta.logLevelName, "INFO");
    const { _meta, time, hostname, ...stable } = record;
    return stable;
  });
  process.stdout.write(
    JSON.stringify({
      arm,
      requestedBytes: size,
      actualMessageBytes: Buffer.byteLength(message),
      records: count + 1,
      elapsedMs,
      cpuMicros,
      peakRssKiB,
      logBytes: fs.statSync(file).size,
      contentSha256: hash(JSON.stringify(normalized)),
      config: { level: settings.level, maxFileBytes: settings.maxFileBytes },
    }),
  );
} else {
  fs.mkdirSync(proofDir, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(proofDir, "owned-logging-"));
  const sources = {
    baseline: path.join(sourceDir, "baseline"),
    candidate: path.join(sourceDir, "candidate"),
  };
  const { runCommandWithTimeout } = await import(
    pathToFileURL(path.join(sources.baseline, "dist/plugin-sdk/process-runtime.js")).href
  );
  const observations = {
    kind: "normal file-logging component; not Gateway throughput",
    runs: [],
    profiles: [],
  };
  let cleanupConfirmed = true;
  let stage = "before workers";
  try {
    for (const size of [8_192, 40_960, 131_072]) {
      for (let trial = 0; trial < 6; trial += 1) {
        const order = trial % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
        for (const arm of order) {
          const runSourceDir = sources[arm];
          const profiled = trial === 5;
          stage = `${arm}, ${size} bytes, trial ${trial}, ${profiled ? "profile" : "timing"}`;
          const dir = path.join(fixtureRoot, `${arm}-${size}-${trial}`);
          for (const child of ["home", "config", "cache", "tmp", "state"]) {
            fs.mkdirSync(path.join(dir, child), { recursive: true });
          }
          const args = [process.execPath];
          if (profiled) {
            args.push("--cpu-prof", `--cpu-prof-dir=${dir}`, "--cpu-prof-name=ordinary.cpuprofile");
          }
          args.push(
            "--import",
            path.join(runSourceDir, "scripts/tsx.mjs"),
            fileURLToPath(import.meta.url),
            "worker",
            runSourceDir,
            dir,
            arm,
            String(size),
            profiled ? "128" : "64",
          );
          let result;
          try {
            result = await runCommandWithTimeout(args, {
              cwd: runSourceDir,
              baseEnv: {},
              env: {
                PATH: process.env.PATH,
                HOME: path.join(dir, "home"),
                XDG_CONFIG_HOME: path.join(dir, "config"),
                XDG_CACHE_HOME: path.join(dir, "cache"),
                TMPDIR: path.join(dir, "tmp"),
                OPENCLAW_STATE_DIR: path.join(dir, "state"),
                LANG: "C.UTF-8",
                LC_ALL: "C.UTF-8",
              },
              input: "",
              timeoutMs: 120_000,
              killProcessTree: true,
              maxOutputBytes: 128 * 1024,
              terminateOnOutputLimit: true,
            });
          } catch (error) {
            cleanupConfirmed = ["normal", "cooperative", "forced"].includes(error?.cleanup);
            throw error;
          }
          cleanupConfirmed = ["normal", "cooperative", "forced"].includes(result.cleanup);
          assert.ok(cleanupConfirmed, "owned worker cleanup uncertain");
          assert.equal(result.termination, "exit");
          assert.equal(result.code, 0, "ordinary file logger worker failed");
          assert.equal(result.stdoutTruncatedBytes, undefined);
          const observation = {
            trial,
            profiled,
            cleanup: result.cleanup,
            ...JSON.parse(result.stdout),
          };
          assert.equal(observation.arm, arm);
          observations.runs.push(observation);
          save("observations.json", observations);
          if (profiled) {
            const profile = JSON.parse(
              fs.readFileSync(path.join(dir, "ordinary.cpuprofile"), "utf8"),
            );
            const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
            const hitIds = new Set(
              profile.nodes
                .filter(
                  (node) =>
                    node.callFrame.functionName === "replacePatternBounded" &&
                    node.callFrame.url.includes("logging/redact-bounded"),
                )
                .map((node) => node.id),
            );
            const descendants = new Set(hitIds);
            for (const id of descendants) {
              for (const child of nodes.get(id)?.children ?? []) {
                descendants.add(child);
              }
            }
            const counts = (profile.samples ?? []).filter((id) => descendants.has(id)).length;
            const observed = profile.nodes
              .filter((node) => hitIds.has(node.id))
              .map((node) => ({
                functionName: node.callFrame.functionName,
                source: "src/logging/redact-bounded.ts",
                samples: (profile.samples ?? []).filter((id) => id === node.id).length,
              }));
            // A profile-node presence alone is not evidence that the affected code ran.
            if (size > 32_768) {
              assert.ok(
                counts > 0,
                "profile did not observe bounded replacement; no performance verdict",
              );
            }
            observations.profiles.push({
              arm,
              size,
              totalSamples: (profile.samples ?? []).length,
              boundedInclusiveSamples: counts,
              observed,
            });
            save("observations.json", observations);
          }
        }
        const pair = observations.runs.filter(
          (run) => run.requestedBytes === size && run.trial === trial,
        );
        assert.equal(pair.length, 2);
        assert.equal(pair[0].records, pair[1].records);
        assert.equal(pair[0].actualMessageBytes, pair[1].actualMessageBytes);
        assert.equal(
          pair[0].contentSha256,
          pair[1].contentSha256,
          "paired complete log output differs",
        );
      }
    }
    for (const size of [8_192, 40_960, 131_072]) {
      const runs = observations.runs.filter((run) => run.requestedBytes === size && !run.profiled);
      assert.equal(runs.length, 10);
      assert.equal(new Set(runs.map((run) => run.contentSha256)).size, 1);
    }
  } catch (error) {
    observations.failure = { stage, type: error?.name ?? "Error" };
    throw error;
  } finally {
    save("observations.json", observations);
    if (cleanupConfirmed) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
}
