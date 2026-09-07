// Reuse the repository's process-tree owner; only bounded structured receipts are public.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, verifySource } from "./proof-integrity.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
export async function runPhase({
  baseline,
  label,
  bin,
  args,
  cwd,
  env,
  timeoutMs,
  publishRoot,
  sourceOverlays = {},
}) {
  assert.match(label, /^[a-z0-9-]+$/u);
  await verifySource(baseline, "baseline", sourceOverlays);
  // Native Node24 type stripping loads this built-in-only owner before dependency installation.
  const { runManagedCommand, hasUnjoinedWork } = await import(
    pathToFileURL(path.join(baseline, "scripts/lib/managed-child-process.mts")).href
  );
  const { createVitestResourceOwner } = await import(
    pathToFileURL(path.join(baseline, "scripts/lib/vitest-resource-ownership.mts")).href
  );
  const tempRoot = await fs.mkdtemp(path.join(env.TMPDIR, "phase-"));
  const ownership = createVitestResourceOwner(tempRoot);
  const phaseEnv = { ...env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot };
  const controller = new AbortController();
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let code;
  let failure;
  const started = Date.now();
  try {
    code = await runManagedCommand({
      bin,
      args,
      cwd,
      env: phaseEnv,
      timeoutMs,
      requireProcessTreeExit: true,
      timeoutForceKillOnLeaderExit: false,
      timeoutKillGraceMs: 30_000,
      abortKillGraceMs: 30_000,
      signal: controller.signal,
      // Claim the configured abort grace before the owner's default signal finalizer.
      onSignal: () => controller.abort(),
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        for (const stream of [child.stdout, child.stderr]) {
          stream.on("data", (chunk) => {
            const remaining = OUTPUT_LIMIT - bytes;
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining));
              bytes += Math.min(chunk.length, remaining);
            }
            if (chunk.length > remaining) {
              overflow = true;
              controller.abort();
            }
          });
        }
      },
    });
  } catch (error) {
    failure = error;
  }
  let unjoined = hasUnjoinedWork(failure);
  try {
    ownership.assertReleased();
  } catch {
    unjoined = true;
  }
  const receipt = {
    label,
    durationMs: Date.now() - started,
    exitCode: code ?? null,
    outputBytes: bytes,
    outputSha256: digest(Buffer.concat(chunks)),
    outputOverflow: overflow,
    outcome: overflow ? "output-limit" : failure || unjoined ? "failed" : "completed",
    diagnosticCodes: [
      ...new Set(
        Buffer.concat(chunks)
          .toString("utf8")
          .match(/\b(?:ERR_[A-Z0-9_]+|TS\d{4})\b/gu) ?? [],
      ),
    ].slice(0, 20),
    cleanupJoined: !unjoined,
  };
  // No child output, argv, environment, config, arbitrary errors or token-bearing state is exported.
  try {
    await fs.writeFile(
      path.join(publishRoot, `${label}-phase.json`),
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Diagnostic failure must not release inputs still owned by unsettled work.
    throw Object.assign(new Error(`Could not persist the ${label} phase receipt`), { unjoined });
  }
  if (failure || overflow || unjoined) {
    throw Object.assign(
      new Error(`Proof phase ${label} did not complete; see its structured receipt`),
      { unjoined },
    );
  }
  return code;
}
