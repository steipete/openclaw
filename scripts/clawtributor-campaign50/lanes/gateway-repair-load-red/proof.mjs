import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, evidence] = process.argv.slice(2);
assert.equal(process.platform, "linux");
const { parseSystemdExecStart, parseSystemdEnvAssignments, splitSystemdLogicalLines } =
  await import(pathToFileURL(path.join(target, "src/daemon/systemd-unit.ts")).href);
const { readSystemdEnvironmentFile } = await import(
  pathToFileURL(path.join(target, "src/daemon/systemd-service-files.ts")).href
);
const { isDefaultInstallIdentity } = await import(
  pathToFileURL(path.join(target, "src/config/paths.ts")).href
);
const { resolveProfileStateDir } = await import(
  pathToFileURL(path.join(target, "src/cli/profile-utils.ts")).href
);
const { resolveGatewaySystemdServiceName } = await import(
  pathToFileURL(path.join(target, "src/daemon/constants.ts")).href
);
const accountHome = await fs.realpath(os.userInfo().homedir);
const root = await fs.mkdtemp(path.join(process.env.HOME, "repair139145-"));
const cases = [];
const failures = [];
const contexts = new Map();
const delay = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function health(ctx, wait = false) {
  const deadline = Date.now() + (wait ? 90_000 : 4_000);
  do {
    try {
      const results = await Promise.all(
        ["healthz", "readyz"].map(async (part) => {
          const response = await fetch(`http://127.0.0.1:${ctx.port}/${part}`, {
            signal: AbortSignal.timeout(2_000),
          });
          await response.arrayBuffer();
          return response.status;
        }),
      );
      if (results.every((code) => code === 200)) return results;
    } catch {
      /* A newly activated owned Gateway may not listen yet. */
    }
    if (!wait) break;
    if (ctx.child && ctx.child.exitCode !== null)
      throw new Error("Owned Gateway exited before readiness");
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("Owned built Gateway did not pass real healthz/readyz");
}
async function stopGateway(ctx) {
  const child = ctx.child;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, "SIGTERM");
    const stopped = await Promise.race([
      ctx.childExit.then(() => true),
      delay(15_000).then(() => false),
    ]);
    if (!stopped) {
      process.kill(-child.pid, "SIGKILL");
      await ctx.childExit;
      throw new Error("Owned Gateway required forced cleanup");
    }
  } else {
    await ctx.childExit;
  }
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") break;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("Owned Gateway process group survived cleanup");
    await delay(50);
  }
  ctx.child = undefined;
}
async function unit(ctx) {
  const bytes = await fs.readFile(ctx.unitPath, "utf8");
  const result = { bytes, argv: [], cwd: "", inline: {}, files: [], unset: [] };
  for (const raw of splitSystemdLogicalLines(bytes)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at),
      value = line.slice(at + 1);
    if (key === "ExecStart") result.argv = parseSystemdExecStart(value);
    if (key === "WorkingDirectory") result.cwd = parseSystemdExecStart(value)[0] ?? "";
    if (key === "Environment")
      for (const entry of parseSystemdEnvAssignments(value)) result.inline[entry.key] = entry.value;
    if (key === "EnvironmentFile") {
      let file = parseSystemdExecStart(value)[0];
      assert.ok(file);
      const optional = file.startsWith("-");
      if (optional) file = file.slice(1);
      assert.ok(path.isAbsolute(file) && file.startsWith(ctx.stateDir + "/"));
      result.files.push([file, optional]);
    }
    if (key === "UnsetEnvironment") result.unset.push(...parseSystemdExecStart(value));
  }
  assert.ok(result.argv.length >= 3 && result.argv.includes("gateway"));
  return result;
}
async function activate(ctx) {
  await stopGateway(ctx);
  const current = await unit(ctx);
  assert.equal(
    current.argv[0],
    process.execPath,
    "Native install must restore the pinned executable",
  );
  const environment = { ...ctx.env, ...current.inline };
  for (const [file, optional] of current.files) {
    try {
      Object.assign(environment, (await readSystemdEnvironmentFile(file)).environment);
    } catch (error) {
      if (!(optional && error.code === "ENOENT")) throw error;
    }
  }
  for (const assignment of current.unset) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    if (separator < 0 || environment[key] === assignment.slice(separator + 1))
      delete environment[key];
  }
  const log = await fs.open(path.join(ctx.dir, `gateway-${ctx.activations}.log`), "w", 0o600);
  const child = spawn(current.argv[0], current.argv.slice(1), {
    cwd: current.cwd || target,
    env: environment,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  ctx.child = child;
  ctx.childExit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await log.close();
  ctx.activations += 1;
  ctx.activated = ctx.armed;
  ctx.activationDigest = digest(current.bytes);
  ctx.calls.push({
    event: "activation-complete",
    armed: ctx.armed,
    pid: child.pid,
    unitSha256: ctx.activationDigest,
  });
}
function property(type, data) {
  return JSON.stringify({ type, data });
}
async function command(ctx, bin, originalArgs) {
  assert.ok(Array.isArray(originalArgs) && originalArgs.every((v) => typeof v === "string"));
  assert.ok(ctx.calls.length < 2000, "Native command count exceeded proof bound");
  const user = originalArgs.includes("--user");
  assert.ok(!originalArgs.includes("--machine"), "Unexpected alternate-manager fallback");
  const args = originalArgs.filter((v) => v !== "--user" && v !== "--json=short");
  let result;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  if (bin === "busctl") {
    assert.ok(user);
    const manager = "org.freedesktop.systemd1";
    if (args[0] === "call") {
      assert.deepEqual(args, [
        "call",
        manager,
        "/org/freedesktop/systemd1",
        `${manager}.Manager`,
        "LoadUnit",
        "s",
        ctx.unitName,
      ]);
      result = (await exists(ctx.unitPath))
        ? ok(property("o", [ctx.objectPath]))
        : { code: 1, stdout: "", stderr: `Call failed: Unit ${ctx.unitName} not found.` };
    } else {
      assert.equal(args[0], "get-property");
      assert.equal(args[1], manager);
      assert.equal(args[2], ctx.objectPath);
      const current = await unit(ctx);
      if (args[3] === `${manager}.Unit`) {
        assert.deepEqual(args.slice(4), [
          "FragmentPath",
          "DropInPaths",
          "NeedDaemonReload",
          "LoadState",
        ]);
        result = ok(
          [
            property("s", ctx.unitPath),
            property("as", []),
            property("b", false),
            property("s", "loaded"),
          ].join("\n"),
        );
      } else {
        assert.equal(args[3], `${manager}.Service`);
        assert.deepEqual(args.slice(4), [
          "ExecStart",
          "WorkingDirectory",
          "Environment",
          "EnvironmentFiles",
          "UnsetEnvironment",
        ]);
        result = ok(
          [
            property("a(sasbttttuii)", [
              [current.argv[0], current.argv, false, 0, 0, 0, 0, 0, 0, 0],
            ]),
            property("s", current.cwd),
            property(
              "as",
              Object.entries(current.inline).map(([k, v]) => `${k}=${v}`),
            ),
            property("a(sb)", current.files),
            property("as", current.unset),
          ].join("\n"),
        );
      }
    }
  } else {
    assert.equal(bin, "systemctl");
    if (!user) {
      if (
        JSON.stringify(args) ===
        JSON.stringify(["show", "--property=LoadState", "--value", ctx.unitName])
      )
        result = ok("not-found\n");
      else if (JSON.stringify(args) === JSON.stringify(["show", "--property=UnitPath", "--value"]))
        result = ok(ctx.systemUnits.join(" ") + "\n");
      else if (
        args[0] === "list-unit-files" &&
        args.every((v) =>
          [
            "list-unit-files",
            "--type=service",
            "--all",
            "--no-legend",
            "--no-pager",
            "--plain",
          ].includes(v),
        )
      )
        result = ok();
      else throw new Error(`Unexpected system manager command: ${JSON.stringify(args)}`);
    } else if (args[0] === "status" && args.length === 1) result = ok("running\n");
    else if (args[0] === "daemon-reload" && args.length === 1) {
      ctx.reloads += 1;
      result = ok();
    } else if (["enable", "restart", "is-enabled"].includes(args[0])) {
      assert.deepEqual(args.slice(1), [ctx.unitName]);
      if (args[0] === "enable") {
        ctx.enables += 1;
        result = ok();
      }
      if (args[0] === "restart") {
        await activate(ctx);
        result = ok();
      }
      if (args[0] === "is-enabled") {
        if (ctx.activated && ctx.fault === "throw")
          result = {
            code: 1,
            stdout: "",
            stderr: "Permission denied: campaign post-install inspection",
          };
        else if (ctx.activated && ctx.fault === "false")
          result = { code: 1, stdout: "disabled\n", stderr: "" };
        else result = ok("enabled\n");
      }
    } else if (args[0] === "show") {
      assert.deepEqual(args, [
        "show",
        ctx.unitName,
        "--no-page",
        "--property",
        "Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
      ]);
      const running = ctx.child && ctx.child.exitCode === null && ctx.child.signalCode === null;
      result = ok(
        `Id=${ctx.unitName}\nLoadState=loaded\nActiveState=${running ? "active" : "inactive"}\nSubState=${running ? "running" : "dead"}\nMainPID=${running ? ctx.child.pid : 0}\nExecMainStatus=0\nExecMainCode=exited\nResult=success\nNRestarts=0\nKillMode=control-group\n`,
      );
    } else throw new Error(`Unexpected user manager command: ${JSON.stringify(args)}`);
  }
  ctx.calls.push({
    bin,
    args: originalArgs,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    postActivation: ctx.activated,
    unitSha256: (await exists(ctx.unitPath)) ? digest(await fs.readFile(ctx.unitPath)) : null,
  });
  return result;
}
const manager = createServer(async (request, response) => {
  const ctx = contexts.get(request.url);
  if (!ctx || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  try {
    const buffers = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 65536);
      buffers.push(chunk);
    }
    const { bin, args } = JSON.parse(Buffer.concat(buffers).toString());
    const result = await command(ctx, bin, args);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    const detail = String(error);
    ctx.errors.push(detail);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ code: 97, stdout: "", stderr: `PROOF_MANAGER_CONTRACT_ERROR ${detail}` }),
      );
  }
});
await new Promise((resolve, reject) => {
  manager.once("error", reject);
  manager.listen(0, "127.0.0.1", resolve);
});
async function groupExists(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function awaitGroupGone(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (await groupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}
async function cli(ctx, args, name) {
  ctx.cliJoined = false;
  const child = spawn(
    process.execPath,
    [
      "--import",
      ctx.preload,
      path.join(target, "openclaw.mjs"),
      "--profile",
      ctx.profile,
      "gateway",
      ...args,
    ],
    { cwd: target, env: ctx.env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout = [],
    stderr = [];
  let bytes = 0,
    spawnError;
  for (const [stream, output] of [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ])
    stream.on("data", (data) => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) child.kill("SIGTERM");
      else output.push(data);
    });
  child.once("error", (error) => {
    spawnError = String(error);
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let result = await Promise.race([closed, delay(120_000).then(() => null)]);
  const timedOut = result === null;
  let forcedCleanup = false;
  if (!result) {
    if (await groupExists(child.pid)) process.kill(-child.pid, "SIGTERM");
    result = await Promise.race([closed, delay(10_000).then(() => null)]);
    if (!result) {
      forcedCleanup = true;
      if (await groupExists(child.pid)) process.kill(-child.pid, "SIGKILL");
      result = await Promise.race([closed, delay(5_000).then(() => null)]);
    }
  }
  let groupGone = await awaitGroupGone(child.pid, 3_000);
  if (!groupGone) {
    forcedCleanup = true;
    process.kill(-child.pid, "SIGTERM");
    groupGone = await awaitGroupGone(child.pid, 5_000);
    if (!groupGone) {
      process.kill(-child.pid, "SIGKILL");
      groupGone = await awaitGroupGone(child.pid, 5_000);
    }
  }
  const out = Buffer.concat(stdout).toString(),
    err = Buffer.concat(stderr).toString();
  ctx.cliJoined = result !== null && groupGone;
  const receipt = {
    ...(result ?? { code: null, signal: null }),
    closed: result !== null,
    spawnError: spawnError ?? null,
    timedOut,
    forcedCleanup,
    groupGone,
    outputBytes: bytes,
  };
  await fs.writeFile(path.join(ctx.dir, `${name}.stdout`), out);
  await fs.writeFile(path.join(ctx.dir, `${name}.stderr`), err);
  await fs.writeFile(path.join(ctx.dir, `${name}.process.json`), JSON.stringify(receipt, null, 2));
  assert.ok(
    result &&
      !spawnError &&
      !timedOut &&
      !forcedCleanup &&
      groupGone &&
      bytes <= 4 * 1024 * 1024 &&
      result.signal === null,
    "Public CLI did not complete with drained output and clean process group",
  );
  return { ...result, stdout: out, stderr: err, value: JSON.parse(out) };
}
async function cleanupContext(ctx) {
  if (ctx.cleaned) return;
  const errors = [];
  let gatewayJoined = false;
  try {
    await stopGateway(ctx);
    gatewayJoined = true;
  } catch (error) {
    errors.push(String(error));
  }
  const canRemoveState = gatewayJoined && ctx.cliJoined !== false;
  if (!canRemoveState)
    errors.push(
      "Retaining named-profile state and unit until disposable VM teardown: process joining is unproven",
    );
  for (const [source, destination] of [
    [ctx.stateDir, "profile-state"],
    [ctx.unitPath, "unit.service"],
    [ctx.unitPath + ".bak", "unit.service.bak"],
  ]) {
    if ((source === ctx.stateDir ? ctx.profileOwned : ctx.unitOwned) && (await exists(source))) {
      try {
        await fs.cp(source, path.join(ctx.dir, destination), {
          recursive: source === ctx.stateDir,
        });
      } catch (error) {
        errors.push(String(error));
      }
    }
  }
  if (canRemoveState) {
    if (ctx.unitOwned)
      for (const file of [ctx.unitPath, ctx.unitPath + ".bak"]) {
        try {
          if (await exists(file)) await fs.unlink(file);
        } catch (error) {
          errors.push(String(error));
        }
      }
    if (ctx.profileOwned) {
      try {
        await fs.rm(ctx.stateDir, { recursive: true });
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      assert.equal(Boolean(ctx.profileOwned) && (await exists(ctx.stateDir)), false);
      assert.equal(Boolean(ctx.unitOwned) && (await exists(ctx.unitPath)), false);
      assert.equal(Boolean(ctx.unitOwned) && (await exists(ctx.unitPath + ".bak")), false);
    } catch (error) {
      errors.push(String(error));
    }
  }
  await fs.writeFile(path.join(ctx.dir, "native-calls.json"), JSON.stringify(ctx.calls, null, 2));
  await fs.writeFile(
    path.join(ctx.dir, "manager-errors.json"),
    JSON.stringify(ctx.errors, null, 2),
  );
  await fs.writeFile(
    path.join(ctx.dir, "cleanup.json"),
    JSON.stringify(
      {
        profile: ctx.profile,
        canonicalIdentity: ctx.canonicalIdentity === true,
        gatewayJoined,
        cliJoined: ctx.cliJoined !== false,
        retainedState: !canRemoveState,
        profileRemoved: !(await exists(ctx.stateDir)),
        unitRemoved: !(await exists(ctx.unitPath)),
        errors,
      },
      null,
      2,
    ),
  );
  await fs.cp(ctx.dir, path.join(evidence, ctx.id), { recursive: true });
  ctx.cleaned = true;
  failures.push(...errors.map((error) => `${ctx.id}: ${error}`));
}

try {
  for (const action of ["start", "restart"])
    for (const fault of ["throw", "false", "healthy"]) {
      const id = `${action}-${fault}`,
        dir = path.join(root, id);
      await fs.mkdir(dir);
      const ctx = {
        id,
        action,
        fault,
        dir,
        home: accountHome,
        port: await freePort(),
        calls: [],
        errors: [],
        activations: 0,
        reloads: 0,
        enables: 0,
        armed: false,
        activated: false,
      };
      ctx.profile = `campaign139145-${id}-${randomUUID().slice(0, 8)}`;
      ctx.env = {
        ...process.env,
        HOME: accountHome,
        OPENCLAW_PROFILE: ctx.profile,
        OPENCLAW_GATEWAY_PORT: String(ctx.port),
        OPENCLAW_SKIP_CHANNELS: "1",
        NO_COLOR: "1",
      };
      for (const key of [
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_SYSTEMD_UNIT",
        "OPENCLAW_LAUNCHD_LABEL",
        "OPENCLAW_WINDOWS_TASK_NAME",
        "OPENCLAW_SERVICE_KIND",
        "OPENCLAW_SERVICE_MARKER",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_WRAPPER",
        "SUDO_USER",
        "SUDO_UID",
        "SUDO_GID",
      ])
        delete ctx.env[key];
      ctx.stateDir = resolveProfileStateDir(ctx.profile, ctx.env);
      ctx.env.OPENCLAW_STATE_DIR = ctx.stateDir;
      ctx.env.OPENCLAW_CONFIG_PATH = path.join(ctx.stateDir, "openclaw.json");
      ctx.unitName = `${resolveGatewaySystemdServiceName(ctx.profile)}.service`;
      ctx.unitPath = path.join(accountHome, ".config/systemd/user", ctx.unitName);
      ctx.systemUnits = ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"];
      ctx.objectPath = "/org/freedesktop/systemd1/unit/campaign139145";
      const route = "/" + randomUUID();
      contexts.set(route, ctx);
      try {
        assert.equal(ctx.stateDir, path.join(accountHome, `.openclaw-${ctx.profile}`));
        assert.equal(
          isDefaultInstallIdentity(ctx.env),
          true,
          "Fixture must use the existing supported native-service identity",
        );
        ctx.canonicalIdentity = true;
        for (const file of [
          ctx.stateDir,
          ctx.unitPath,
          ctx.unitPath + ".bak",
          ...ctx.systemUnits.map((systemDir) => path.join(systemDir, ctx.unitName)),
        ])
          assert.equal(await exists(file), false, "Refusing a preexisting named-profile path");
        await fs.mkdir(ctx.stateDir);
        ctx.profileOwned = true;
        ctx.unitOwned = true;
        await fs.writeFile(
          ctx.env.OPENCLAW_CONFIG_PATH,
          JSON.stringify({
            gateway: {
              mode: "local",
              port: ctx.port,
              bind: "loopback",
              auth: { mode: "token", token: "campaign139145-synthetic" },
              controlUi: { enabled: false },
            },
            agents: {
              defaults: {
                workspace: path.join(ctx.stateDir, "workspace"),
                heartbeat: { every: "0m" },
              },
            },
            logging: { file: path.join(dir, "gateway-structured.log") },
          }),
        );
        const url = `http://127.0.0.1:${manager.address().port}${route}`;
        const bin = path.join(dir, "bin");
        await fs.mkdir(bin);
        for (const name of ["systemctl", "busctl"])
          await fs.writeFile(
            path.join(bin, name),
            `#!${process.execPath}\n(async()=>{const r=await fetch(${JSON.stringify(url)},{method:"POST",body:JSON.stringify({bin:${JSON.stringify(name)},args:process.argv.slice(2)}),signal:AbortSignal.timeout(25000)});const v=await r.json();process.stdout.write(v.stdout);process.stderr.write(v.stderr);process.exitCode=v.code;})().catch(e=>{console.error(String(e));process.exitCode=98;});\n`,
            { mode: 0o700 },
          );
        ctx.preload = path.join(dir, "native-command-boundary.mjs");
        await fs.writeFile(
          ctx.preload,
          `import cp from "node:child_process";import path from "node:path";import {syncBuiltinESMExports} from "node:module";const select=c=>["systemctl","busctl"].includes(path.basename(c))?path.join(${JSON.stringify(bin)},path.basename(c)):c;const spawn=cp.spawn,execFile=cp.execFile;cp.spawn=(c,...a)=>spawn(select(c),...a);cp.execFile=(c,...a)=>execFile(select(c),...a);syncBuiltinESMExports();\n`,
        );
        const installed = await cli(ctx, ["install", "--force", "--json"], "seed-install");
        assert.equal(installed.code, 0);
        assert.equal(installed.value.ok, true);
        assert.equal(installed.value.result, "installed");
        assert.equal(ctx.activations, 1);
        await health(ctx, true);
        assert.deepEqual(ctx.errors, []);
        if (action === "start") await stopGateway(ctx);
        const before = await unit(ctx);
        assert.equal(before.argv[0], process.execPath);
        const missingNode = path.join(ctx.stateDir, "retired-runtime/node");
        assert.equal(await exists(missingNode), false);
        const oldExec = before.bytes.match(/^ExecStart=(.*)$/m);
        assert.ok(oldExec);
        const stale = before.bytes.replace(
          oldExec[0],
          `ExecStart=${[missingNode, ...before.argv.slice(1)].map((value) => JSON.stringify(value)).join(" ")}`,
        );
        await fs.writeFile(ctx.unitPath, stale);
        assert.equal((await unit(ctx)).argv[0], missingNode);
        ctx.calls = [];
        ctx.errors = [];
        ctx.armed = true;
        ctx.activated = false;
        const result = await cli(ctx, [action, "--json"], "action");
        const readiness = await health(ctx, true);
        assert.deepEqual(ctx.errors, []);
        assert.equal(ctx.activations, 2);
        assert.ok(ctx.reloads >= 2 && ctx.enables >= 2);
        const activation = ctx.calls.findIndex(
          (row) => row.event === "activation-complete" && row.armed,
        );
        assert.ok(activation >= 0);
        const probes = ctx.calls
          .slice(activation + 1)
          .filter((row) => row.bin === "systemctl" && row.args.includes("is-enabled"));
        assert.ok(
          probes.length > 0 &&
            probes.every((row) => row.postActivation && row.unitSha256 === ctx.activationDigest),
        );
        assert.notEqual(digest(stale), ctx.activationDigest);
        assert.equal((await unit(ctx)).argv[0], process.execPath);
        const succeeded =
          result.code === 0 &&
          result.value.ok === true &&
          result.value.result === (action === "start" ? "started" : "restarted") &&
          result.value.service?.loaded === true;
        const errorText = typeof result.value.error === "string" ? result.value.error : "";
        const repairFailed =
          result.code === 1 &&
          result.value.ok === false &&
          result.value.result === undefined &&
          errorText.startsWith("Gateway repair failed:");
        const matchesContract =
          fault === "healthy"
            ? succeeded
            : repairFailed &&
              errorText.includes(
                fault === "throw"
                  ? "Permission denied: campaign post-install inspection"
                  : "not loaded after repair",
              );
        if (fault === "throw")
          assert.ok(
            probes.some(
              (row) =>
                row.code === 1 &&
                row.stderr === "Permission denied: campaign post-install inspection",
            ),
          );
        if (fault === "false")
          assert.ok(probes.some((row) => row.code === 1 && row.stdout.trim() === "disabled"));
        if (fault === "healthy")
          assert.ok(probes.every((row) => row.code === 0 && row.stdout.trim() === "enabled"));
        cases.push({
          id,
          action,
          fault,
          profile: ctx.profile,
          canonicalIdentity: ctx.canonicalIdentity,
          cli: { code: result.code, value: result.value },
          readiness,
          postInstallProbes: probes.length,
          unitBefore: digest(stale),
          unitAfter: ctx.activationDigest,
          contractViolated: !matchesContract,
        });
      } finally {
        await cleanupContext(ctx);
        contexts.delete(route);
      }
    }
} catch (error) {
  failures.push(String(error));
} finally {
  for (const ctx of contexts.values()) {
    try {
      await cleanupContext(ctx);
    } catch (error) {
      failures.push(String(error));
    }
  }
  await new Promise((resolve, reject) =>
    manager.close((error) => (error ? reject(error) : resolve())),
  );
  if (failures.length === 0) await fs.rm(root, { recursive: true });
  await fs.writeFile(
    path.join(evidence, "behavior.json"),
    JSON.stringify(
      { complete: cases.length === 6, cases, failures, cleanupComplete: failures.length === 0 },
      null,
      2,
    ),
  );
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 2;
} else {
  const violations = cases.filter((row) => row.contractViolated).length;
  console.log(
    violations
      ? `POST_INSTALL_PROBE_FALSE_SUCCESS: ${violations} native CLI outcomes violated verification`
      : "POST_INSTALL_VERIFICATION_CONTRACT_PASSED",
  );
  process.exitCode = violations ? 1 : 0;
}
