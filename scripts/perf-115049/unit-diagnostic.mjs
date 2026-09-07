// Task-only projection: report content never supplies public names or arbitrary string values.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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
  let report;
  let jsonStatus = "present";
  try {
    const handle = await fs.open(reportFile, "r");
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
  };
  try {
    await fs.writeFile(outputFile, JSON.stringify(diagnostic, null, 2) + "\n", { mode: 0o600 });
  } catch {
    throw Object.assign(new Error("Could not persist the safe unit diagnostic"), { unjoined });
  }
  return report;
}
