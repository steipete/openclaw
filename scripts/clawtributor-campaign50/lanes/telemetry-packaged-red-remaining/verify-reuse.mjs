import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export function dependencyVersions(node) {
  return {
    version: node.version ?? null,
    overridden: node.overridden ?? false,
    dependencies: Object.fromEntries(
      Object.entries(node.dependencies ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [name, dependencyVersions(value)]),
    ),
  };
}

export function verifyReuse(inputDir, manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.source, "0a55c7c0d199da69e343ddf10115cb2dcba71b16");
  assert.equal(manifest.runId, 34078660938);
  assert.equal(manifest.jobId, 101609628104);
  assert.equal(manifest.harness, "02a4b70842855a852a63394e1fb132e12189fdbe");
  assert.equal(manifest.artifactId, 10003125023);
  assert.equal(manifest.classification, "HARNESS_ORACLE_FAILURE");
  const read = (name) => readFileSync(path.join(inputDir, name));
  const json = (name) => JSON.parse(read(name).toString("utf8"));
  for (const [relative, expected] of Object.entries(manifest.files)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split("/").includes(".."));
    const absolute = path.join(inputDir, relative);
    assert.equal(lstatSync(absolute).isFile(), true, `${relative}: ordinary file required`);
    const bytes = read(relative);
    assert.equal(bytes.length, expected.size, `${relative}: size`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      `${relative}: hash`,
    );
  }
  const prior = json("observed.json");
  assert.equal(prior.source, manifest.source);
  assert.equal(prior.phase, "controls");
  assert.equal(prior.cleanupFailureCount, 0);
  assert.deepEqual(prior.cleanupFailures, []);
  assert.equal(prior.failure.name, "AssertionError");
  assert.deepEqual(
    prior.processes.map((entry) => entry.name),
    [
      "pack",
      "install",
      "installed-dependencies",
      "archive-openclaw.mjs",
      "archive-build-info.json",
      "version",
      "explicit-help",
    ],
  );
  for (const entry of prior.processes) {
    assert.equal(entry.exitCode, 0, `${entry.name}: prior normal exit`);
    assert.equal(entry.signal, null);
    assert.equal(entry.processError, null);
    for (const key of [
      "timedOut",
      "outputLimit",
      "residualGroup",
      "forcedTermination",
      "interrupted",
    ])
      assert.ok(!entry[key]);
  }
  assert.equal(read("source-sha.txt").toString().trim(), manifest.source);
  const sources = read("source-files.sha256").toString().trim().split("\n");
  assert.equal(sources.length, 49);
  for (const name of ["source-before.log", "source-after.log"]) {
    const lines = read(name).toString().trim().split("\n");
    assert.deepEqual(
      lines,
      sources.map((line) => `${line.slice(66)}: OK`),
    );
  }
  assert.equal(read("final-tracked.patch").length, 0);
  assert.equal(read("final-working-tree.patch").length, 0);
  const installed = json("installed.json");
  assert.equal(installed.buildInfo.commit, manifest.source);
  assert.equal(installed.manifestVersion, "2026.9.2");
  assert.deepEqual(installed, prior.installed);
  const versionLine = `OpenClaw 2026.9.2 (${manifest.source.slice(0, 7)})\n`;
  assert.equal(read("version.stdout.log").toString(), versionLine);
  assert.equal(read("version.stderr.log").length, 0);
  assert.equal(read("explicit-help.stderr.log").length, 0);
  for (const name of ["version", "explicit-help"])
    assert.deepEqual(read(`${name}.config-before.json`), read(`${name}.config-after.json`));
  const text = read("explicit-help.stdout.log").toString("utf8");
  const usage = "Usage: openclaw telemetry [options] [command]";
  const start = text.indexOf(usage);
  assert.ok(start >= 0);
  assert.equal(
    text.slice(0, start).trim(),
    `OpenClaw 2026.9.2 (${manifest.source.slice(0, 7)}) — All your chats, one OpenClaw.`,
  );
  const parentHelp = text.slice(start);
  assert.match(parentHelp, /Inspect and manage anonymous usage telemetry/);
  assert.deepEqual(
    parentHelp
      .split("Commands:\n")[1]
      .trim()
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " ")),
    [
      "help Display help for command",
      "off Disable anonymous feature statistics",
      "on Enable anonymous feature statistics",
      "show Show exactly what the daily update request sends",
    ],
  );
  const packReceipts = json("pack.json");
  assert.equal(packReceipts.length, 1);
  const receipt = packReceipts[0];
  const tarball = path.join(inputDir, "package/openclaw-telemetry-140283.tgz");
  const bytes = read("package/openclaw-telemetry-140283.tgz");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "7685287f10ecb765d2ce60a0550f6310eb48610d5552ffc301a4bc77bc4c33f3",
  );
  assert.equal(receipt.integrity, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  assert.equal(receipt.shasum, createHash("sha1").update(bytes).digest("hex"));
  assert.equal(receipt.name, "openclaw");
  assert.equal(receipt.version, "2026.9.2");
  return {
    manifest,
    tarball,
    receipt,
    installed,
    parentHelp,
    dependencies: json("installed-dependencies.json"),
    priorClassification: "HARNESS_ORACLE_FAILURE",
    correctedCachedHelp: "validated",
    originalBareParentExecuted: false,
  };
}
