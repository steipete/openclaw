// Task-only projection: report content never supplies public names or arbitrary string values.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const status = (value) =>
  ["passed", "failed", "pending", "skipped", "todo"].includes(value) ? value : "unknown";
function failure(raw, repo, sourceFiles) {
  if (typeof raw !== "string") {
    return { kind: "absent", frames: [] };
  }
  if (raw.length > 65_536) {
    return { kind: "oversized", frames: [] };
  }
  const text = stripVTControlCharacters(raw);
  const first = text.split("\n", 1)[0];
  const timeout = /^(?:Error: )?(?:Test|Hook) timed out in ([0-9]{1,8})ms\b/u.exec(first);
  const kind = timeout
    ? "timeout"
    : /^(?:AssertionError|AssertionError \[ERR_ASSERTION\]):/u.test(first)
      ? "assertion"
      : /^(?:TypeError|ReferenceError|SyntaxError|RangeError):/u.test(first)
        ? "language-error"
        : "other";
  const frames = [];
  for (const line of text.split("\n")) {
    if (!/^\s*(?:at|❯)\s/u.test(line)) {
      continue;
    }
    const start = line.indexOf(`${repo}/`);
    const match =
      start < 0
        ? null
        : /^([^:()]+):([0-9]{1,6}):([0-9]{1,5})(?:\s|[)]|$)/u.exec(
            line.slice(start + repo.length + 1),
          );
    if (match && Object.hasOwn(sourceFiles, match[1])) {
      frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
    }
    if (frames.length === 6) {
      break;
    }
  }
  const result = { kind, frames };
  if (timeout) {
    result.timeoutMs = Number(timeout[1]);
  }
  if (kind === "assertion") {
    // Only literal count/boolean assertions have a safe, unambiguous projection here.
    const calls =
      /^AssertionError: expected "[^"\r\n]{1,160}" to be called ([0-9]{1,8}) times, but got ([0-9]{1,8}) times$/u.exec(
        first,
      );
    const values =
      /^AssertionError: expected (true|false|[0-9]{1,8}) to (?:be|equal) (true|false|[0-9]{1,8})(?: \/\/ Object\.is equality)?$/u.exec(
        first,
      );
    const scalar = (value) => (value === "true" ? true : value === "false" ? false : Number(value));
    if (calls) {
      result.assertion = "call-count";
      result.expected = Number(calls[1]);
      result.actual = Number(calls[2]);
    } else if (values) {
      result.assertion = "scalar-equality";
      result.actual = scalar(values[1]);
      result.expected = scalar(values[2]);
    }
  }
  return result;
}
async function readArtifactJson(file) {
  let report;
  let jsonStatus = "present";
  try {
    const handle = await fs.open(file, "r");
    try {
      const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, count);
        if (read.bytesRead === 0) {
          break;
        }
        count += read.bytesRead;
      }
      if (count === bytes.length) {
        jsonStatus = "too-large";
      } else {
        try {
          report = JSON.parse(bytes.subarray(0, count).toString("utf8"));
        } catch {
          jsonStatus = "invalid";
        }
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    jsonStatus = error?.code === "ENOENT" ? "missing" : "unreadable";
  }
  return { report, jsonStatus };
}
export async function writeUnitDiagnostic({
  repo,
  reportFile,
  outputFile,
  inventory,
  sourceFiles,
  exitCode,
  unjoined,
  sourceRuntimeVerified,
}) {
  for (const [file, entry] of Object.entries(inventory.files)) {
    assert.equal(
      sourceFiles[file]?.sha256,
      entry.sha256,
      "diagnostic inventory differs from pinned source",
    );
  }
  let { report, jsonStatus } = await readArtifactJson(reportFile);
  const modules = Array.isArray(report?.testResults) ? report.testResults : [];
  if (jsonStatus === "present" && !Array.isArray(report?.testResults)) {
    jsonStatus = "invalid-shape";
  }
  const files = [];
  let unexpectedFiles = 0;
  for (const module of modules.slice(0, 16)) {
    const file = typeof module?.name === "string" ? path.relative(repo, module.name) : "";
    const known = Object.hasOwn(inventory.files, file) ? inventory.files[file] : undefined;
    if (!known) {
      unexpectedFiles += 1;
      continue;
    }
    if (files.some((entry) => entry.file === file)) {
      unexpectedFiles += 1;
      continue;
    }
    const cases = Array.isArray(module.assertionResults) ? module.assertionResults : [];
    files.push({
      file,
      status: status(module.status),
      failure: failure(module.message, repo, sourceFiles),
      caseCount: cases.length,
      omittedCases: Math.max(0, cases.length - 256),
      cases: cases.slice(0, 256).map((test, index) => {
        const location = integer(test?.location?.line);
        const named = known.tests.find((entry) => entry.name === test?.title);
        const located =
          location === null
            ? undefined
            : known.tests.find((entry) => location >= entry.line && location <= entry.titleEndLine);
        const source = named ?? located;
        const messages = Array.isArray(test?.failureMessages) ? test?.failureMessages : [];
        return {
          index,
          sourceName: source?.name ?? null,
          sourceLine: source?.line ?? null,
          nameOrigin: named ? "static-name" : located ? "source-location" : "unknown",
          status: status(test?.status),
          reportedLine: location,
          failureCount: messages.length,
          omittedFailures: Math.max(0, messages.length - 3),
          failures: messages.slice(0, 3).map((message) => failure(message, repo, sourceFiles)),
        };
      }),
    });
  }
  const diagnostic = {
    format: "vitest5-source-known-unit-status",
    jsonStatus,
    exitCode: integer(exitCode),
    cleanupJoined: !unjoined,
    sourceRuntimeVerified,
    success: typeof report?.success === "boolean" ? report.success : null,
    totalTests: integer(report?.numTotalTests),
    failedTests: integer(report?.numFailedTests),
    unexpectedFiles,
    omittedFiles: Math.max(0, modules.length - 16),
    files,
    runner: unjoined
      ? { status: "unsettled" }
      : await readRunnerDiagnostic(repo, reportFile, sourceFiles, inventory),
  };
  try {
    await fs.writeFile(outputFile, JSON.stringify(diagnostic, null, 2) + "\n", { mode: 0o600 });
  } catch {
    throw Object.assign(new Error("Could not persist the safe unit diagnostic"), { unjoined });
  }
  return report;
}

// Native report-owner paths are constructed from ordinals, never followed from report contents.
async function readRunnerDiagnostic(repo, reportFile, sourceFiles, inventory) {
  const parent = path.dirname(reportFile);
  let wrapperMarkers = { status: "missing" };
  try {
    const outputFile = path.join(parent, "candidate-runner.log");
    const stat = await fs.stat(outputFile);
    assert.ok(stat.size <= 2 * 1024 * 1024);
    const text = await fs.readFile(outputFile, "utf8");
    assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
    const detectorPath = "scripts/lib/vitest-unhandled-errors.mts";
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(path.join(repo, detectorPath)))
        .digest("hex"),
      sourceFiles[detectorPath]?.sha256,
    );
    const { createVitestUnhandledErrorDetector } = await import(
      pathToFileURL(path.join(repo, detectorPath)).href
    );
    const detector = createVitestUnhandledErrorDetector();
    detector.observe(text);
    const unhandled = detector.finish();
    const timeout =
      /\[vitest\] no output for ([0-9]{1,8})ms; terminating stalled Vitest process group\./u.exec(
        text,
      );
    wrapperMarkers = {
      status: "present",
      noOutputTimeoutMs: timeout ? Number(timeout[1]) : null,
      nativeAggregatePublished: text.includes("[test] native JSON aggregate:"),
      reportPublicationFailed: text.includes("[test] report publication failed; retained"),
      workerVerificationStarted: text.includes(
        "[vitest-workers] verifying completed generation before cleanup",
      ),
      workerSourceChanged: text.includes("Source changed during compiled subprocess invocation:"),
      workerArtifactChanged: text.includes("Compiled subprocess artifact changed:"),
      workerJoinRetained: text.includes("[vitest-workers] retaining "),
      unhandledCount: unhandled ? integer(unhandled.count) : null,
      frames: failure(text, repo, sourceFiles).frames,
    };
  } catch {
    wrapperMarkers = { status: "unavailable" };
  }
  const prefix = `${path.basename(reportFile)}.reports-`;
  const sets = (await fs.readdir(parent)).filter((name) => name.startsWith(prefix));
  if (sets.length !== 1) {
    return {
      status: sets.length === 0 ? "missing" : "ambiguous",
      setCount: sets.length,
      wrapperMarkers,
    };
  }
  const directory = path.join(parent, sets[0]);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { status: "invalid-directory", wrapperMarkers };
  }
  const index = await readArtifactJson(path.join(directory, "index.json"));
  if (index.jsonStatus !== "present" || !Array.isArray(index.report?.entries)) {
    return { status: "index-unavailable", jsonStatus: index.jsonStatus, wrapperMarkers };
  }
  const knownPath = (value) => {
    const relative = typeof value === "string" ? path.relative(repo, value) : "";
    return Object.hasOwn(sourceFiles, relative) ? relative : null;
  };
  const outcome = (value) => ({
    code: integer(value?.code),
    signal:
      value?.signal === null
        ? null
        : ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(value?.signal)
          ? value.signal
          : "unknown",
    noOutputTimedOut: typeof value?.noOutputTimedOut === "boolean" ? value.noOutputTimedOut : null,
    groupJoined: typeof value?.groupJoined === "boolean" ? value.groupJoined : null,
  });
  const capture = async (file) => {
    const value = await readArtifactJson(file);
    const ended = value.report?.ended;
    return {
      jsonStatus: value.jsonStatus,
      reason: ["passed", "failed", "interrupted"].includes(ended?.reason)
        ? ended.reason
        : "unknown",
      unhandledErrors: integer(ended?.unhandledErrors),
      failedModules: integer(ended?.failedModules),
      suiteErrors: integer(ended?.suiteErrors),
      processTimedOut:
        typeof value.report?.processTimedOut === "boolean" ? value.report.processTimedOut : null,
    };
  };
  // This exact existing frozen-graph codec matches Vitest5's bundled Flatted representation.
  const codecRoot = path.join(repo, "node_modules/.pnpm/flatted@3.4.4/node_modules/flatted");
  const codecPath = path.join(codecRoot, "esm/index.js");
  let fromJSON;
  let codecStatus = "unavailable-or-mismatch";
  try {
    const codecPackage = JSON.parse(
      await fs.readFile(path.join(codecRoot, "package.json"), "utf8"),
    );
    assert.equal(codecPackage.version, "3.4.4");
    assert.equal(codecPackage.type, "module");
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(codecPath))
        .digest("hex"),
      "d697ad948769363b99110e1bffe84269a7e74955b42e4e74abac61b02f6c9de6",
    );
    ({ fromJSON } = await import(pathToFileURL(codecPath).href));
    codecStatus = "verified";
  } catch {
    // Missing/mismatched codec keeps capture outcomes available but never decodes with another path.
  }
  // Vitest's last-test field is temporal provenance, not causal fault attribution.
  const projectError = (error, module = null) => {
    const origin = knownPath(error?.VITEST_TEST_PATH);
    const rawName = error?.VITEST_TEST_NAME;
    const lastObservedTest =
      origin && inventory.files[origin]?.tests.find((entry) => entry.name === rawName)?.name;
    return {
      errorClass: [
        "Error",
        "AssertionError",
        "TypeError",
        "ReferenceError",
        "SyntaxError",
        "RangeError",
        "AggregateError",
        "AbortError",
        "TimeoutError",
        "EnvironmentTeardownError",
        "SessionTranscriptReadFenceError",
      ].includes(error?.name)
        ? error.name
        : "unknown",
      type: ["Unhandled Error", "Unhandled Rejection", "Uncaught Exception"].includes(error?.type)
        ? error.type
        : "unknown",
      module,
      origin,
      lastObservedTest: lastObservedTest || null,
      details: failure(
        typeof error?.stack === "string"
          ? error.stack
          : typeof error?.stackStr === "string"
            ? error.stackStr
            : error?.message,
        repo,
        sourceFiles,
      ),
    };
  };
  const blob = async (file) => {
    const value = await readArtifactJson(file);
    if (value.jsonStatus !== "present") {
      return { status: value.jsonStatus };
    }
    if (!fromJSON) {
      return { status: "codec-unavailable" };
    }
    let decoded;
    try {
      decoded = fromJSON(value.report);
    } catch {
      return { status: "invalid-flatted" };
    }
    if (
      !Array.isArray(decoded) ||
      decoded[0] !== "5.0.0" ||
      !Array.isArray(decoded[1]) ||
      !Array.isArray(decoded[2])
    ) {
      return { status: "invalid-blob-shape" };
    }
    const suiteErrors = [];
    const queue = decoded[1]
      .slice(0, 16)
      .map((task) => ({ task, module: knownPath(task?.filepath) }));
    const seen = new Set();
    for (let cursor = 0; cursor < queue.length && cursor < 1024; cursor += 1) {
      const { task, module } = queue[cursor];
      if (!task || typeof task !== "object" || seen.has(task)) {
        continue;
      }
      seen.add(task);
      if (task.type === "suite" && Array.isArray(task.result?.errors)) {
        for (const error of task.result.errors.slice(0, 8)) {
          if (suiteErrors.length < 16) {
            suiteErrors.push(projectError(error, module));
          }
        }
      }
      if (Array.isArray(task.tasks)) {
        queue.push(
          ...task.tasks
            .slice(0, Math.max(0, 1024 - queue.length))
            .map((child) => ({ task: child, module })),
        );
      }
    }
    return {
      status: "present",
      version: decoded[0],
      unhandledCount: decoded[2].length,
      omittedUnhandled: Math.max(0, decoded[2].length - 16),
      unhandled: decoded[2].slice(0, 16).map((error) => projectError(error)),
      suiteErrors,
      taskTraversalBoundReached: seen.size >= 1024,
    };
  };
  const entries = [];
  for (const [ordinal, entry] of index.report.entries.slice(0, 8).entries()) {
    const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
    const projected = [];
    for (const [attemptOrdinal, attempt] of attempts.slice(0, 3).entries()) {
      const attemptDirectory = path.join(
        directory,
        String(ordinal + 1),
        String(attemptOrdinal + 1),
      );
      const nativeJson = await readArtifactJson(path.join(attemptDirectory, "report.json"));
      const snapshot = nativeJson.report?.snapshot;
      projected.push({
        attempt: attemptOrdinal + 1,
        nativeJsonStatus: nativeJson.jsonStatus,
        snapshot: {
          failure: typeof snapshot?.failure === "boolean" ? snapshot.failure : null,
          unchecked: integer(snapshot?.unchecked),
          unmatched: integer(snapshot?.unmatched),
        },
        outcome: outcome(attempt?.outcome),
        wrapperFailure: failure(attempt?.error, repo, sourceFiles),
        capture: await capture(path.join(attemptDirectory, "report.json.capture.json")),
        blob: await blob(path.join(attemptDirectory, "blob.json")),
      });
    }
    entries.push({
      invocation: ordinal + 1,
      config: knownPath(path.resolve(repo, typeof entry?.config === "string" ? entry.config : "")),
      state: ["unstarted", "started", "finished", "error"].includes(entry?.state)
        ? entry.state
        : "unknown",
      acceptedAttempt: integer(entry?.acceptedAttempt),
      omittedAttempts: Math.max(0, attempts.length - 3),
      attempts: projected,
    });
  }
  return {
    status: "present",
    wrapperMarkers,
    codecStatus,
    complete: index.report.complete === true,
    merge: outcome(index.report.merge),
    wrapperFailure: failure(index.report.error, repo, sourceFiles),
    aggregateCapture: await capture(path.join(directory, "aggregate.json.capture.json")),
    omittedInvocations: Math.max(0, index.report.entries.length - 8),
    entries,
  };
}
