import assert from "node:assert/strict";
import {
  checkOutput,
  oldDescription,
  newDescription,
  oldFooter,
  newFooter,
  preview,
} from "./read-output.mjs";

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
const root = (description) =>
  `Usage: openclaw [options] [command]\nCommands:\n  reset      Reset local config/state (keeps the CLI installed)\n  uninstall  ${description}\n  update     Update OpenClaw\n`;
const leaf = (description) =>
  `Usage: openclaw uninstall [options]\n\n${description}\n\nOptions:\n${flags.map((flag) => `  ${flag}  synthetic option description`).join("\n")}\nDocs: docs.openclaw.ai/cli/uninstall\n`;
let accepted = 0;
let rejected = 0;
for (const phase of ["baseline", "candidate"]) {
  const description = phase === "baseline" ? oldDescription : newDescription;
  const footer = phase === "baseline" ? oldFooter : newFooter;
  const metadata = { rootHelpText: root(description) };
  for (const [id, stdout] of [
    ["root-help", root(description)],
    ["uninstall-help", leaf(description)],
    ["service-preview", `${preview}\n${footer}\n`],
  ]) {
    checkOutput(id, phase, stdout, "", metadata);
    accepted++;
  }
  const bad = [
    ["root-help", root(description).replace("  uninstall", "  unrelated"), "", metadata],
    ["root-help", root(description), "", { rootHelpText: root(description) + "changed\n" }],
    [
      "root-help",
      root(description).replace(description, "wrong description"),
      "",
      { rootHelpText: root(description).replace(description, "wrong description") },
    ],
    ["uninstall-help", leaf(description).replace("  --state", "  --other"), "", metadata],
    [
      "uninstall-help",
      leaf(description).replace("docs.openclaw.ai/cli/uninstall", "wrong-docs"),
      "",
      metadata,
    ],
    ["uninstall-help", leaf(description).replace(description, "wrong description"), "", metadata],
    ["service-preview", `${footer}\n`, "", metadata],
    ["service-preview", `${footer}\n${preview}\n`, "", metadata],
    ["service-preview", `${preview}\n${footer}\n${footer}\n`, "", metadata],
    ["service-preview", `${preview}\n${oldFooter}\n${newFooter}\n`, "", metadata],
    [
      "service-preview",
      `${preview}\n${footer}\n`,
      "CLI cleanup timed out: memory after 5000ms\n",
      metadata,
    ],
  ];
  for (const args of bad) {
    assert.throws(() => checkOutput(args[0], phase, args[1], args[2], args[3]));
    rejected++;
  }
}
process.stdout.write(
  `${JSON.stringify({ dataOnly: true, targetImports: false, accepted, rejected })}\n`,
);
