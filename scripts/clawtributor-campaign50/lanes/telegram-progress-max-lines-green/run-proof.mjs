import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [targetArg, laneArg, evidenceArg, mode] = process.argv.slice(2);
const target = path.resolve(targetArg);
const lane = path.resolve(laneArg);
const evidence = path.resolve(evidenceArg);
assert.equal(mode, "green");
assert.equal(process.version, "v24.20.0");
const packet = JSON.parse(fs.readFileSync(path.join(lane, "PACKET.json"), "utf8"));
const owner = "extensions/telegram/src/bot-message-dispatch.progress-updates.test.ts";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
fs.mkdirSync(evidence, { recursive: true });
fs.copyFileSync(path.join(lane, "PACKET.json"), path.join(evidence, "packet.json"));
const receipt = { phase: "preflight", passed: false, commands: [], mode, source: packet.source };
const save = () =>
  fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
let applied = false;
function verify() {
  assert.equal(git("rev-parse", "HEAD"), packet.source);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  const expectedPaths = applied ? owner : "";
  assert.equal(git("diff", "--name-only"), expectedPaths);
  assert.equal(git("ls-files", "--others", "--exclude-standard"), "");
  for (const [file, expected] of Object.entries(packet.sourceHashes)) {
    assert.equal(
      hash(fs.readFileSync(path.join(target, file))),
      applied && file === owner ? packet.candidateSha256 : expected,
      file,
    );
  }
  for (const [file, expected] of Object.entries(packet.files)) {
    assert.equal(hash(fs.readFileSync(path.join(lane, file))), expected, file);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
  assert.equal(pkg.packageManager, packet.packageManager);
  for (const [dependency, version] of Object.entries(packet.dependencies)) {
    assert.equal(pkg.devDependencies[dependency], version);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(target, "node_modules", dependency, "package.json"), "utf8"),
      ).version,
      version,
    );
  }
  if (applied) {
    assert.equal(git("diff", "--numstat"), `22\t84\t${owner}`);
    git("diff", "--check");
  }
}
try {
  verify();
  const { runManagedCommand } = await import(
    pathToFileURL(path.join(target, "scripts/lib/managed-child-process.mts"))
  );
  async function run(name, bin, args) {
    const row = { name, bin, args, startedAt: new Date().toISOString(), managedJoined: false };
    receipt.commands.push(row);
    const out = [],
      err = [],
      combined = [];
    let bytes = 0;
    const abort = new AbortController();
    try {
      row.code = await runManagedCommand({
        bin,
        args,
        cwd: target,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        requireProcessTreeExit: true,
        signal: abort.signal,
        onReady(child) {
          row.pid = child.pid;
          for (const [stream, chunks] of [
            [child.stdout, out],
            [child.stderr, err],
          ]) {
            stream.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 10 * 1024 * 1024) {
                row.outputLimitExceeded = true;
                abort.abort();
              } else {
                chunks.push(chunk);
                combined.push(chunk);
              }
            });
          }
        },
      });
      row.managedJoined = true;
    } catch (error) {
      row.error = {
        message: String(error.message),
        code: error.code,
        processTreeState: error.processTreeState,
      };
      throw error;
    } finally {
      row.finishedAt = new Date().toISOString();
      row.outputBytes = bytes;
      for (const [suffix, chunks] of [
        ["stdout", out],
        ["stderr", err],
        ["log", combined],
      ]) {
        const output = Buffer.concat(chunks);
        fs.writeFileSync(path.join(evidence, `${name}.${suffix}`), output);
        row[`${suffix}Sha256`] = hash(output);
      }
      save();
    }
    assert.equal(row.outputLimitExceeded ?? false, false);
    assert.equal(row.code, 0, name);
    return row;
  }
  const candidate = fs.readFileSync(path.join(lane, "candidate.test.ts"));
  assert.equal(hash(candidate), packet.candidateSha256);
  fs.writeFileSync(path.join(target, owner), candidate);
  applied = true;
  verify();
  receipt.phase = "format";
  await run("format", path.join(target, "node_modules/.bin/oxfmt"), ["--check", owner]);
  receipt.phase = "tests";
  await run("tests", process.execPath, [
    "scripts/run-vitest.mjs",
    "run",
    owner,
    "--reporter=verbose",
    "--reporter=json",
    `--outputFile=${path.join(evidence, "tests.json")}`,
  ]);
  await run("test-verdict", process.execPath, [
    path.join(lane, "verify-tests.mjs"),
    evidence,
    lane,
    "0",
  ]);
  verify();
  receipt.phase = "lint-plan";
  await run("lint-plan", process.execPath, [
    "--import",
    "tsx",
    path.join(lane, "lint-plan.mjs"),
    target,
  ]);
  const plan = JSON.parse(fs.readFileSync(path.join(evidence, "lint-plan.stdout"), "utf8"));
  assert(plan.some((shard) => shard.args.includes("extensions/telegram")));
  receipt.lintPlan = plan;
  receipt.phase = "lint";
  await run("lint", process.execPath, [
    "--import",
    "tsx",
    "scripts/run-oxlint-shards.mts",
    "--only=extensions",
    "--extension-stripe=5/6",
    "--threads=1",
  ]);
  const lintLog = fs.readFileSync(path.join(evidence, "lint.log"), "utf8");
  assert.doesNotMatch(
    lintLog,
    /\[oxlint[^\]]*\].*(?:failed|timed out|killing|did not exit cleanly)/i,
  );
  const passed = [...lintLog.matchAll(/^\[oxlint:([^\]]+)\] passed$/gm)].map((match) => match[1]);
  assert.deepEqual(passed.slice().sort(), plan.map((shard) => shard.name).sort());
  verify();
  receipt.phase = "complete";
  receipt.passed = true;
  receipt.tests = 37;
  receipt.candidateSha256 = packet.candidateSha256;
  receipt.cleanup =
    "Every command joined by canonical process-group and pipe owner; no new test state owner";
} catch (error) {
  receipt.error = { message: String(error.message), stack: error.stack };
  throw error;
} finally {
  try {
    verify();
    receipt.finalSourceVerified = true;
  } catch (error) {
    receipt.passed = false;
    receipt.finalSourceError = String(error.message);
    process.exitCode = 1;
  }
  fs.writeFileSync(
    path.join(evidence, "actual.patch"),
    execFileSync("git", ["diff", "--binary"], { cwd: target }),
  );
  save();
}
