import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const evidence = process.argv[2];
const frames = JSON.parse(readFileSync(path.join(evidence, "frames.json"), "utf8"));
assert.deepEqual(
  frames.map((frame) => frame.step),
  [1, 2, 3],
);
const escape = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
for (const [name, rows] of [
  ["initial", frames[0].before],
  ["accepted-event-baseline", frames[2].frame],
]) {
  assert.ok(rows.length <= frames[0].rows);
  const width = frames[0].cols * 9 + 32;
  const height = frames[0].rows * 20 + 70;
  const text = rows
    .map(
      (row, index) =>
        `<text x="16" y="${68 + index * 20}" xml:space="preserve">${escape(row)}</text>`,
    )
    .join("\n");
  writeFileSync(
    path.join(evidence, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<title>${escape(name)}: captured native TUI cells</title>
<desc>Monochrome rendering of recorded synchronized terminal cells, not a desktop screenshot. Original rows retained.</desc>
<rect width="100%" height="100%" fill="#111827"/>
<text x="16" y="26" fill="#d1d5db" font-family="sans-serif" font-size="14">Captured native terminal cells — ${escape(name)}</text>
<g fill="#f9fafb" font-family="monospace" font-size="14">${text}</g>
</svg>\n`,
  );
}
