import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, evidence, stage] = process.argv.slice(2);
assert.ok(target && evidence && ["baseline", "candidate"].includes(stage));
const load = (file) => import(pathToFileURL(path.join(target, file)));
const gateway = await load("src/cli/gateway-run-argv.ts");
const { isCronMachineOutput } = await load("src/cli/cron-cli/output-mode.ts");
const { resolveChannelsAddChannelFromArgv } = await load("src/cli/channels-cli-add-args.ts");
const argv = (args) => ["node", "openclaw", ...args];
const records = [];
fs.mkdirSync(evidence, { recursive: true });
function observe(name, actual, expected) {
  records.push({ name, actual, expected });
  fs.writeFileSync(
    path.join(evidence, `changed-boundaries-${stage}.json`),
    JSON.stringify(records, null, 2) + "\n",
  );
  assert.deepEqual(actual, expected, name);
}
observe(
  "pre-root-gateway-foreground",
  gateway.isForegroundGatewayRunArgv(argv(["--force", "gateway", "run"])),
  stage === "baseline",
);
observe(
  "pre-root-gateway-catalog",
  gateway.resolveGatewayCatalogCommandPath(argv(["--port", "18789", "gateway", "status"])),
  stage === "baseline" ? ["gateway", "status"] : null,
);
for (const root of ["cron", "automations"]) {
  observe(
    `${root}-pre-root-machine-output`,
    isCronMachineOutput(argv(["--expect-final", root, "status"])),
    stage === "baseline",
  );
}
const selected = await resolveChannelsAddChannelFromArgv(
  argv(["--agent", "work", "channels", "add", "--channel", "fixture"]),
);
observe(
  "pre-root-channel-parent-option",
  { value: selected ?? null, type: typeof selected },
  stage === "baseline" ? { value: "fixture", type: "string" } : { value: null, type: "undefined" },
);
observe(
  "post-root-channel-parent-option",
  await resolveChannelsAddChannelFromArgv(
    argv(["channels", "--agent", "work", "add", "--channel", "fixture"]),
  ),
  "fixture",
);
console.log(`ROOT_OPTION_CHANGED_BOUNDARIES_${stage.toUpperCase()} cases=${records.length}`);
