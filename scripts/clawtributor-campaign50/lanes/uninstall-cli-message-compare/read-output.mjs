import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

export const oldDescription = "Uninstall the gateway service + local data (CLI remains)";
export const newDescription = "Uninstall the gateway service + local data";
export const oldFooter = "CLI still installed. Remove via npm/pnpm if desired.";
export const newFooter = "CLI removal instructions: https://docs.openclaw.ai/install/uninstall";
export const preview = "[dry-run] remove gateway service";
const flags = [
  "--all",
  "--app",
  "--dry-run",
  "--help",
  "--non-interactive",
  "--service",
  "--state",
  "--workspace",
  "--yes",
];
export const plain = (value) => stripVTControlCharacters(value).replaceAll("\r\n", "\n");
const normalized = (value) => value.trim().replace(/\s+/gu, " ");

export function uninstallRow(text) {
  const lines = plain(text).split("\n");
  const matches = lines.flatMap((line, index) => (/^  uninstall\s+/u.test(line) ? [index] : []));
  assert.equal(matches.length, 1, "Expected one named uninstall root-help row");
  const index = matches[0];
  const parts = [lines[index].replace(/^  uninstall\s+/u, "")];
  for (let i = index + 1; i < lines.length && /^ {4,}\S/u.test(lines[i]); i++) parts.push(lines[i]);
  return normalized(parts.join(" "));
}

export function rejectCliFailure(text) {
  for (const line of plain(text).split("\n")) {
    assert(!/^CLI cleanup timed out: /u.test(line), "CLI reported unfinished cleanup");
    assert(
      !/^\[openclaw\] Failed to (?:display help|respawn launcher):/u.test(line),
      "CLI startup failed",
    );
    assert(
      !/^(?:The CLI command failed\.|Could not start the CLI\.|OpenClaw hit an unexpected runtime error\.)$/u.test(
        line.trim(),
      ),
      "CLI failure diagnostic",
    );
  }
}

export function checkOutput(id, phase, stdout, stderr, metadata) {
  assert(["baseline", "candidate"].includes(phase));
  const description = phase === "baseline" ? oldDescription : newDescription;
  const footer = phase === "baseline" ? oldFooter : newFooter;
  const otherFooter = phase === "baseline" ? newFooter : oldFooter;
  const output = plain(stdout);
  rejectCliFailure(`${stdout}\n${stderr}`);
  if (id === "root-help") {
    assert.equal(typeof metadata?.rootHelpText, "string");
    assert.equal(
      output,
      plain(metadata.rootHelpText),
      "Actual root output differs from generated metadata",
    );
    assert.equal(uninstallRow(output), description);
    return { description, metadataMatchesActualOutput: true };
  }
  if (id === "uninstall-help") {
    const lines = output.split("\n").map((line) => line.trim());
    assert(lines.some((line) => /^Usage: openclaw uninstall \[options\]$/u.test(line)));
    assert.equal(lines.filter((line) => line === description).length, 1);
    assert.equal(output.includes(phase === "baseline" ? newFooter : oldDescription), false);
    const observedFlags = output
      .split("\n")
      .flatMap((line) => {
        const match = /^\s+(?:-[A-Za-z],\s+)?(--[a-z-]+)(?:\s|$)/u.exec(line);
        return match ? [match[1]] : [];
      })
      .sort();
    assert.deepEqual(observedFlags, flags);
    assert(output.includes("docs.openclaw.ai/cli/uninstall"));
    return { description, flags: observedFlags, docs: "docs.openclaw.ai/cli/uninstall" };
  }
  assert.equal(id, "service-preview");
  const lines = output.split("\n").map((line) => line.trim());
  assert.equal(lines.filter((line) => line === preview).length, 1);
  assert.equal(lines.filter((line) => line === footer).length, 1);
  assert.equal(output.includes(otherFooter), false);
  assert(lines.indexOf(preview) < lines.indexOf(footer));
  return { preview, footer };
}
