import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [target, lane, evidence, mode] = process.argv.slice(2);
assert.ok(mode === "red" || mode === "green");
const { PtyTestScreen } = await import(
  pathToFileURL(`${target}/src/tui/tui-pty-test-support.ts`).href
);
const { iterateAnsiSegments } = await import(
  pathToFileURL(`${target}/packages/terminal-core/src/ansi-sequences.ts`).href
);
const cases = JSON.parse(readFileSync(`${lane}/cases.json`, "utf8"));
const processes = JSON.parse(readFileSync(`${evidence}/processes.json`, "utf8"));
assert.equal(processes.quiescent, true);
assert.equal(processes.ownedFixtureRemoved, true);
assert.equal(processes.retainedState, null);
assert.equal(processes.cancelledSignal, null);
assert.deepEqual(
  processes.records.map((row) => row.id),
  cases.map((row) => row.id),
);
const results = [];
const esc = "\x1b";
function replay(raw, columns, allowedOsc) {
  const screen = new PtyTestScreen({ cols: columns, rows: 100 });
  const osc = [];
  for (const part of iterateAnsiSegments(raw)) {
    if (part.kind === "text") {
      assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(part.value), "unparsed terminal control");
      screen.write(part.value, true);
    } else if (part.value.startsWith(`${esc}]`)) {
      assert.ok(allowedOsc.has(part.value), "unexpected OSC");
      osc.push(part.value);
    } else {
      const sgr = part.value.match(/^\x1b\[([0-9;]*)m$/u);
      const cursor = part.value.match(/^\x1b\[([1-9][0-9]{0,2})([AG])$/u);
      const supported = sgr
        ? sgr[1] === "" ||
          sgr[1].split(";").every((value) => /^[0-9]{1,3}$/u.test(value) && Number(value) <= 255)
        : cursor
          ? Number(cursor[1]) <= (cursor[2] === "A" ? 100 : columns)
          : /^\x1b\[(?:H|(?:0|2)?[JK]|\?25[hl])$/u.test(part.value);
      assert.ok(supported, `unsupported CSI ${JSON.stringify(part.value)}`);
      assert.deepEqual(part.controls, []);
      screen.applyCsi(part.value, true);
    }
  }
  return {
    rows: screen.cells.map((row) =>
      row
        .map((cell) => cell.text)
        .join("")
        .trimEnd(),
    ),
    osc,
  };
}
for (const [index, cell] of cases.entries()) {
  const process = JSON.parse(readFileSync(`${evidence}/${cell.id}/process.json`, "utf8"));
  assert.deepEqual(process, processes.records[index]);
  assert.equal(process.exitCode, 0);
  for (const field of ["spawned", "joined", "groupGone", "eof"]) assert.equal(process[field], true);
  assert.equal(process.forced, false);
  assert.equal(process.error, undefined);
  const bytes = readFileSync(`${evidence}/${cell.id}/raw.ansi`);
  assert.equal(bytes.length, process.rawBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), process.rawSha256);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const child = JSON.parse(readFileSync(`${evidence}/${cell.id}/child.json`, "utf8"));
  const label = cell.label ?? "Checking channel status (probe)…";
  assert.equal(child.id, cell.id);
  assert.equal(child.label, label);
  const updatedLabel = cell.label
    ? label.replace("Scanning", "Checking")
    : "Checking channel status (ready)…";
  assert.equal(child.updatedLabel, updatedLabel);
  assert.equal(child.columns, cell.finalColumns ?? cell.columns);
  assert.equal(child.initialColumns, cell.columns);
  assert.equal(child.finalMessage, cell.finalMessage ?? null);
  assert.equal(
    child.result,
    cell.kind === "wizard"
      ? "wizard completed"
      : cell.kind === "delayed"
        ? "delayed completed"
        : "work completed",
  );
  for (const field of ["completed", "listenersRestored", "rawInputRestored"])
    assert.equal(child[field], true);
  assert.equal(child.suppressed, mode === "green" && cell.id === "core-6");
  const phases = [
    "begin",
    ...(cell.kind === "delayed" ? ["resize-request"] : []),
    ...(child.suppressed ? ["suppressed"] : []),
    "updated",
    "active",
    "done",
    "settled",
  ];
  const expectedProgressOsc = [
    `${esc}]9;4;3;;${label}${esc}\\`,
    `${esc}]9;4;3;;${updatedLabel}${esc}\\`,
    `${esc}]9;4;0;0;${updatedLabel}${esc}\\`,
  ];
  const allowedOsc = new Set([
    ...phases.map((phase) => `${esc}]777;progress-proof;${phase}\x07`),
    ...expectedProgressOsc,
  ]);
  const positions = phases.map((phase) => {
    const marker = `${esc}]777;progress-proof;${phase}\x07`;
    assert.equal(raw.split(marker).length, 2, `exact phase ${phase}`);
    return raw.indexOf(marker);
  });
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
  assert.equal(raw.slice(positions.at(-1) + `${esc}]777;progress-proof;settled\x07`.length), "");
  if (cell.kind === "delayed") {
    assert.ok(Number.isSafeInteger(process.resizeByteOffset) && process.resizeByteOffset > 0);
    const beforeResize = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, process.resizeByteOffset),
    );
    assert.equal(
      [...iterateAnsiSegments(beforeResize)]
        .filter((part) => part.kind === "text")
        .map((part) => part.value)
        .join(""),
      "",
      "real resize precedes any visible frame",
    );
  }
  const active = replay(
    raw.slice(0, positions[phases.indexOf("active")]),
    child.columns,
    allowedOsc,
  );
  const done = replay(raw.slice(0, positions[phases.indexOf("done")]), child.columns, allowedOsc);
  const settled = replay(raw, child.columns, allowedOsc);
  assert.deepEqual(settled.rows, done.rows, "no output after stopping");
  const osc = settled.osc.filter((value) => value.startsWith(`${esc}]9;4;`));
  assert.deepEqual(
    osc,
    expectedProgressOsc,
    "exact initial/update/clear OSC messages with full labels",
  );
  const painted = [
    ...iterateAnsiSegments(raw.slice(positions[0], positions[phases.indexOf("active")])),
  ]
    .filter((part) => part.kind === "text")
    .map((part) => part.value)
    .join("");
  const activeRows = active.rows.filter(Boolean);
  const doneRows = done.rows.filter(Boolean);
  const framePattern = cell.kind === "wizard" ? /\((?:\\\/|\|\||--)\)/gu : /[◒◐◓◑•oO0]  /gu;
  const frames = [...painted.matchAll(framePattern)].length;
  assert.deepEqual(
    process.readySignals.map((entry) => entry.byte),
    ["S", "A"],
  );
  for (const [index, ready] of process.readySignals.entries()) {
    assert.ok(
      Number.isSafeInteger(ready.offset) && ready.offset > 0 && ready.offset <= bytes.length,
    );
    const prefix = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, ready.offset),
      { stream: true },
    );
    const plain = prefix
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
    assert.equal([...plain.matchAll(framePattern)].length, ready.frames);
    assert.ok(child.suppressed ? ready.frames === 0 : ready.frames >= (index === 0 ? 1 : 26));
    if (index === 1) assert.ok(prefix.includes(`${esc}]777;progress-proof;updated\x07`));
  }
  if (cell.id !== "core-6" || mode === "red")
    assert.ok(frames >= 26, "at least 26 real animation frames");
  let conforms = true;
  if (cell.id === "wizard-tiny") {
    assert.ok(
      painted.includes("(||)") || painted.includes("(--)") || painted.includes("(\\/)"),
      "wizard retains custom animation",
    );
    assert.ok(!painted.includes("Checking"), "wizard empty label keeps full text only in OSC");
  } else if (cell.id === "core-6") {
    conforms = !/[◒◐◓◑•oO0]/u.test(painted);
  } else {
    assert.ok(activeRows.length >= 2, "actual guide and animation were rendered");
    conforms = activeRows.length === 2;
    if (cell.expectedBaseline === "pass") assert.equal(conforms, true, "existing width control");
  }
  if (cell.finalMessage) {
    const visibleRaw = [...iterateAnsiSegments(raw)]
      .filter((part) => part.kind === "text")
      .map((part) => part.value)
      .join("");
    assert.equal(
      visibleRaw.split(cell.finalMessage).length,
      2,
      "explicit final message is complete",
    );
  } else if (cell.kind === "wizard" && cell.id !== "wizard-tiny") {
    assert.equal(doneRows.length, 1, "wizard clear retains only the guide");
  } else if (conforms && cell.kind !== "wizard") {
    assert.ok(doneRows.length <= 2, "ordinary progress leaves no stale text");
  }
  if (cell.id === "wizard-unicode") {
    assert.ok(painted.includes("👨‍👩‍👧‍👦"), "whole family grapheme remains");
    assert.ok(painted.includes("…"), "long Unicode label is clipped");
  }
  const snapshots = { active: active.rows, done: done.rows, settled: settled.rows };
  writeFileSync(`${evidence}/${cell.id}/screen.json`, JSON.stringify(snapshots, null, 2));
  const html = (text) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  writeFileSync(
    `${evidence}/${cell.id}/screen.html`,
    `<!doctype html><meta charset="utf-8"><title>${cell.id}</title><style>body{background:#111;color:#eee;font:16px monospace}pre{white-space:pre}</style><h1>${cell.id}</h1><h2>Active</h2><pre>${html(activeRows.join("\n"))}</pre><h2>Stopped</h2><pre>${html(doneRows.join("\n"))}</pre>`,
  );
  results.push({
    id: cell.id,
    conforms,
    frames,
    activeRows: activeRows.length,
    doneRows: doneRows.length,
    expectedBaseline: cell.expectedBaseline,
  });
}
const failures = results.filter((row) => !row.conforms).map((row) => row.id);
writeFileSync(
  `${evidence}/outcomes.json`,
  JSON.stringify(
    { mode, results, failures, source: "6aa09cbadb594c3d46d5bd49a28c514df1b256b0" },
    null,
    2,
  ),
);
assert.deepEqual(
  failures,
  mode === "red" ? ["core-32", "core-36", "core-6", "core-delayed-shrink"] : [],
);
console.log(JSON.stringify({ accepted: true, mode, cases: results.length, failures }));
