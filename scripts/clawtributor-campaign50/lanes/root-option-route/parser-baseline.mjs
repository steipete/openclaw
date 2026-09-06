import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, evidence] = process.argv.slice(2);
assert.ok(target && evidence);
const load = (file) => import(pathToFileURL(path.join(target, file)));
const root = await load("src/infra/cli-root-options.ts");
const routes = await load("src/cli/program/route-args.ts");
const { resolveCliArgvInvocation } = await load("src/cli/argv-invocation.ts");
const gateway = await load("src/cli/gateway-run-argv.ts");
const { isCronMachineOutput } = await load("src/cli/cron-cli/output-mode.ts");
const argv = (args) => ["node", "openclaw", ...args];
const records = [];
fs.mkdirSync(evidence, { recursive: true });
function observe(name, actual, expected) {
  records.push({ name, actual, expected });
  fs.writeFileSync(
    path.join(evidence, "parser-baseline.json"),
    JSON.stringify(records, null, 2) + "\n",
  );
  assert.deepEqual(actual, expected, name);
}

observe(
  "status-pre-root-is-incorrectly-accepted",
  routes.parseStatusRouteArgs(argv(["--json", "status"]))?.json,
  true,
);
observe(
  "health-pre-root-is-incorrectly-accepted",
  routes.parseHealthRouteArgs(argv(["--json", "health"]))?.json,
  true,
);
observe(
  "value-prefix-can-miss-discovery",
  resolveCliArgvInvocation(argv(["--timeout", "2000", "health"])).commandPath,
  ["2000", "health"],
);
observe(
  "valid-status-post-root",
  routes.parseStatusRouteArgs(argv(["status", "--json"]))?.json,
  true,
);
observe(
  "valid-health-root-profile",
  routes.parseHealthRouteArgs(argv(["--profile", "health", "health", "--json"]))?.json,
  true,
);

for (const [name, args, expected] of [
  ["models-parent-option", ["models", "--agent", "work", "status"], ["models", "status"]],
  ["models-flag-looking-value", ["models", "--agent", "--json", "status"], ["models", "status"]],
  [
    "update-value-matches-command",
    ["update", "--channel", "cleanup", "status"],
    ["update", "status"],
  ],
  ["channels-parent-option", ["channels", "--agent", "work", "add"], ["channels", "add"]],
  ["skills-parent-option", ["skills", "--agent", "work", "verify"], ["skills", "verify"]],
  ["config-parent-option", ["config", "--section", "models", "get"], ["config", "get"]],
  ["gateway-flag-looking-value", ["gateway", "--port", "--json", "run"], ["gateway", "run"]],
])
  observe(name, resolveCliArgvInvocation(argv(args)).commandPath, expected);

observe(
  "required-root-value-is-terminator",
  root.getRootOptionAwareCommandPath(argv(["--profile", "--", "health", "--json"]), 2),
  ["health"],
);
observe(
  "literal-root-discovery",
  root.getRootOptionAwareCommandPath(argv(["--", "config", "get"]), 2),
  ["config", "get"],
);
observe(
  "literal-route-declines",
  routes.parseHealthRouteArgs(argv(["--", "health", "--json"])),
  null,
);
for (const [name, args] of [
  ["leading-literal-tail", ["--", "channels", "add", "--channel", "fixture"]],
  ["parent-literal-tail", ["channels", "--", "add", "--channel", "fixture"]],
])
  observe(
    name,
    root.getCommandArgsWithRootOptions(argv(args), {
      commandPath: ["channels", "add"],
      mode: "command-path",
    }),
    ["--", "--channel", "fixture"],
  );
observe(
  "gateway-value-not-reset",
  gateway.resolveGatewayRunPreBootstrapOptions(argv(["gateway", "--token", "--reset", "run"])),
  { force: false, reset: false },
);
observe(
  "gateway-real-flags-classified-only",
  gateway.resolveGatewayRunPreBootstrapOptions(argv(["gateway", "run", "--force", "--reset"])),
  { force: true, reset: true },
);
observe(
  "gateway-foreground-parent-options",
  gateway.isForegroundGatewayRunArgv(
    argv(["--profile", "work", "gateway", "--port", "18789", "run"]),
  ),
  true,
);
observe(
  "cron-parent-json",
  isCronMachineOutput(argv(["cron", "--timeout", "2000", "status"])),
  true,
);
observe(
  "automation-alias-parent-json",
  isCronMachineOutput(argv(["automations", "--port=18789", "status"])),
  true,
);
console.log(`ROUTE_OPTION_PARSER_BASELINE_CONFIRMED cases=${records.length}`);
