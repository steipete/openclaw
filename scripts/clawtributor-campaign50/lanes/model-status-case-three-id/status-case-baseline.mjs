import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [targetDir, evidenceDir] = process.argv.slice(2);
assert.ok(targetDir && evidenceDir, "target and evidence directories are required");
const observed = { phase: "control", cases: [], cleanupFailures: [] };
const ownedHomes = [];
let failure;
const save = (name, value) => writeFileSync(path.join(evidenceDir, name), value);
mkdirSync(evidenceDir, { recursive: true });

function runCase(name, collision) {
  const proofHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-status-case-"));
  ownedHomes.push(proofHome);
  const workspace = path.join(proofHome, "workspace");
  const scratch = path.join(proofHome, "tmp");
  mkdirSync(workspace);
  mkdirSync(scratch);
  const responsesId = collision ? "rEaDeR" : "Writer";
  const modelIds = ["Reader", responsesId, "reader"];
  const primary = "openai/Reader";
  const fallbacks = [`openai/${responsesId}`, "openai/reader"];
  const config = {
    agents: {
      ownership: "explicit",
      entries: { qa: { name: "Status proof", workspace } },
      defaults: {
        model: { primary, fallbacks },
        modelPolicy: { allow: modelIds.map((id) => `openai/${id}`) },
        utilityModel: "",
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://models.example.test/v1",
          models: modelIds.map((id) => ({
            id,
            name: id,
            ...(id === "Reader"
              ? { api: "openai-completions" }
              : id === responsesId
                ? { api: "openai-responses" }
                : {}),
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
    },
  };
  assert.equal(Object.hasOwn(config.models.providers.openai, "api"), false);
  assert.equal(Object.hasOwn(config.models.providers.openai.models.at(-1), "api"), false);
  const configPath = path.join(proofHome, "openclaw.json");
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, configText);
  save(`${name}.config.json`, configText);
  const args = [
    path.join(targetDir, "openclaw.mjs"),
    "models",
    "status",
    "--json",
    "--check",
    "--agent",
    "qa",
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: targetDir,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: proofHome,
      USERPROFILE: proofHome,
      XDG_CONFIG_HOME: path.join(proofHome, "config"),
      TMPDIR: scratch,
      CI: "1",
      NO_COLOR: "1",
      OPENAI_API_KEY: "status-proof-placeholder",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(proofHome, "state"),
    },
  });
  save(`${name}.stdout.log`, child.stdout ?? "");
  save(`${name}.stderr.log`, child.stderr ?? "");
  const result = {
    name,
    args,
    exitCode: child.status,
    signal: child.signal,
    processError: child.error?.message ?? null,
  };
  observed.cases.push(result);
  assert.equal(result.processError, null, `${name}: process error`);
  assert.equal(result.signal, null, `${name}: process signal`);
  assert.equal(typeof result.exitCode, "number", `${name}: missing process exit`);
  assert.doesNotMatch(
    child.stderr,
    /unhandled|uncaught|(?:^|\n)\s*(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|AggregateError):/i,
    `${name}: unexpected process failure diagnostic`,
  );
  const payload = JSON.parse(child.stdout);
  save(`${name}.json`, `${JSON.stringify(payload, null, 2)}\n`);
  result.payload = payload;
  assert.equal(payload.agentId, "qa", `${name}: exact agent`);
  assert.equal(payload.defaultModel, primary, `${name}: selected primary`);
  assert.equal(payload.resolvedDefault, primary, `${name}: resolved primary`);
  assert.deepEqual(payload.fallbacks, fallbacks, `${name}: fallbacks`);
  assert.deepEqual([...payload.allowed].sort(), modelIds.map((id) => `openai/${id}`).sort());
  assert.deepEqual(payload.utilityModel, { ref: null, source: "disabled" });
  assert.equal(payload.imageModel, null);
  assert.deepEqual(payload.imageFallbacks, []);
  assert.deepEqual(payload.auth.missingProvidersInUse, [], `${name}: unexpected missing auth`);
  assert.deepEqual(payload.auth.runtimeAuthRoutes, [], `${name}: unexpected native runtime route`);
  return { payload, result };
}

try {
  const control = runCase("control", false);
  assert.equal(control.result.exitCode, 0, "noncolliding three-ID control must be healthy");
  assert.deepEqual(
    control.payload.auth.modelRouteIssues,
    [],
    "noncolliding three-ID control diagnostics",
  );
  observed.phase = "three-id-collision";
  const target = runCase("case-collision", true);
  assert.equal(target.result.exitCode, 1, "three-ID collision baseline must report check failure");
  assert.deepEqual(
    target.payload.auth.modelRouteIssues,
    [
      {
        kind: "incompatible",
        provider: "openai",
        model: "reader",
        code: "ambiguous-openai-route-group",
        message:
          "Observed OpenAI routes disagree on the Platform adapter for an authored endpoint.",
      },
    ],
    "STATUS_CASE_THREE_ID_140099: only reader must report the exact false ambiguity",
  );
  observed.phase = "expected-red-confirmed";
} catch (error) {
  failure = error;
  observed.failure = { name: error.name, message: error.message };
} finally {
  for (const proofHome of ownedHomes) {
    try {
      rmSync(proofHome, { recursive: true });
    } catch (error) {
      observed.cleanupFailures.push({ path: proofHome, message: error.message });
    }
  }
  observed.cleanupFailureCount = observed.cleanupFailures.length;
  save("observed.json", `${JSON.stringify(observed, null, 2)}\n`);
}
if (failure) throw failure;
assert.equal(observed.cleanupFailureCount, 0, "fixture cleanup failed");
console.log("STATUS_CASE_THREE_ID_140099_BASELINE_RED_CONFIRMED");
