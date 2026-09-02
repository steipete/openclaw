// Remote-only supervisor owns cleanup even when the real fatal handler exits the child.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [rootArg, manifestArg, revision, outputArg] = process.argv.slice(2);
assert(rootArg && manifestArg && outputArg && ["baseline", "candidate"].includes(revision));
const root = path.resolve(rootArg);
const manifest = path.resolve(manifestArg);
const output = path.resolve(outputArg);
const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), "completion-fatal-proof.mts");
const expected = JSON.parse(readFileSync(manifest, "utf8"));
assert.match(expected.head, /^[a-f0-9]{40}$/);
mkdirSync(output, { recursive: true });
const results = [];
for (const mode of ["grace-error", "awaited"]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "completion-proof-child-"));
  let result;
  try {
    result = spawnSync(process.execPath, [
      "--import", path.join(root, "scripts/tsx.mjs"), driver, root, manifest, mode, home,
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        NODE_ENV: "production",
        CI: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  writeFileSync(path.join(output, `${mode}.stdout`), result.stdout ?? "");
  writeFileSync(path.join(output, `${mode}.stderr`), result.stderr ?? "");
  const events = (result.stdout ?? "").split("\n")
    .filter((line) => line.startsWith("PROOF_EVENT "))
    .map((line) => JSON.parse(line.slice("PROOF_EVENT ".length)).event);
  const verdictLine = (result.stdout ?? "").split("\n")
    .find((line) => line.startsWith("PROOF_VERDICT "));
  const verdict = verdictLine ? JSON.parse(verdictLine.slice("PROOF_VERDICT ".length)) : null;
  const fatalExpected = revision === "baseline" && mode === "grace-error";
  const observed = { mode, exitCode: result.status, signal: result.signal, events, verdict,
    spawnError: result.error?.message ?? null };
  results.push(observed);
  writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ revision, expected, results }, null, 2) + "\n");
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, fatalExpected ? 1 : 0);
  if (fatalExpected) {
    assert.deepEqual(events, ["grace-scheduled", "completion-attempt-1", "completion-attempt-2", "resume-failed"]);
    assert.equal(verdict, null);
    assert.match(result.stderr, /Unhandled promise rejection:.*synthetic completion resume failure/s);
  } else {
    assert.equal(verdict?.head, expected.head);
    assert.equal(verdict?.alive, true);
    assert.equal(verdict?.attempts, 2);
    assert.equal(verdict?.rowRetained, true);
  }
}
writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ revision, expected, results, passed: true }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ revision, head: expected.head, checks: results.length, passed: true }) + "\n");
