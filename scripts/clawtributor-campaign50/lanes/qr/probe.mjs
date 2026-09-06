import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [targetDir, evidenceDir, mode] = process.argv.slice(2);
if (!["red", "green"].includes(mode)) throw new Error("Unknown proof mode");
const records = [];
const proofHome = await mkdtemp(path.join(os.tmpdir(), "openclaw-qr-output-"));
const check = (condition, label) => {
  if (!condition) throw new Error(label);
};
function decodeCode(code, expectedUrl) {
  check(/^[A-Za-z0-9_-]+$/.test(code), "setup code is not base64url");
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    throw new Error("setup code is not a JSON payload");
  }
  check(decoded.url === expectedUrl, "setup URL mismatch");
  check(
    typeof decoded.bootstrapToken === "string" && decoded.bootstrapToken.length > 0,
    "missing synthetic bootstrap token",
  );
  check(typeof decoded.expiresAtMs === "number", "missing bootstrap expiry");
}
try {
  for (const command of [["qr"], ["clawbot", "qr"]]) {
    let lanJsonWarning;
    for (const scenario of [
      { name: "bare-only", flags: ["--setup-code-only"] },
      { name: "json-only", flags: ["--json"] },
      { name: "bare-then-json", flags: ["--setup-code-only", "--json"], combined: true },
      { name: "json-then-bare", flags: ["--json", "--setup-code-only"], combined: true },
      { name: "lan-json-only", flags: ["--json"], lan: true },
      {
        name: "lan-reverse-combined",
        flags: ["--json", "--setup-code-only"],
        combined: true,
        lan: true,
      },
      { name: "lan-combined", flags: ["--setup-code-only", "--json"], combined: true, lan: true },
      { name: "lan-bare-only", flags: ["--setup-code-only"], lan: true },
    ]) {
      const caseHome = await mkdtemp(path.join(proofHome, "case-"));
      const host = scenario.lan ? "192.168.77.2" : "127.0.0.1";
      const expectedUrl = `ws://${host}:18789`;
      const configPath = path.join(caseHome, "openclaw.json");
      await writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            bind: "custom",
            customBindHost: host,
            auth: { mode: "token", token: "synthetic-qr-output-proof" },
          },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(targetDir, "openclaw.mjs"), ...command, ...scenario.flags],
        {
          cwd: targetDir,
          env: {
            PATH: process.env.PATH,
            HOME: caseHome,
            USERPROFILE: caseHome,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: path.join(caseHome, "state"),
            OPENCLAW_TEST_FAST: "1",
            NO_COLOR: "1",
          },
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const id = `${command.join("-")}/${scenario.name}`;
      check(!result.error && result.status === 0, `${id}: CLI did not exit 0`);
      let outputKind;
      if (scenario.combined && mode === "red") {
        check(result.stdout === "", `${id}: expected exact empty stdout for baseline defect`);
        const stderrCodes = result.stderr
          .split(/\r?\n/)
          .filter((line) => /^[A-Za-z0-9_-]{50,}$/.test(line));
        check(stderrCodes.length === 1, `${id}: expected one misplaced setup code on stderr`);
        decodeCode(stderrCodes[0], expectedUrl);
        outputKind = "empty-stdout-code-on-stderr";
      } else if (scenario.flags.includes("--json")) {
        let payload;
        try {
          payload = JSON.parse(result.stdout);
        } catch {
          throw new Error(`${id}: stdout is not one JSON document`);
        }
        check(
          payload.gatewayUrl === expectedUrl && payload.auth === "token",
          `${id}: JSON metadata mismatch`,
        );
        check(
          payload.access === (scenario.lan ? "limited" : "full"),
          `${id}: access metadata changed`,
        );
        check(
          payload.accessDowngraded === (scenario.lan ? true : undefined),
          `${id}: downgrade metadata changed`,
        );
        if (scenario.lan) {
          const hasWarning = result.stderr.includes("setup code was limited for safety");
          if (scenario.name === "lan-json-only") lanJsonWarning = hasWarning;
          else
            check(
              hasWarning === lanJsonWarning,
              `${id}: warning differs from existing JSON-only mode`,
            );
        }
        decodeCode(payload.setupCode, expectedUrl);
        check(
          !result.stderr.includes(payload.setupCode),
          `${id}: JSON setup code also logged to stderr`,
        );
        outputKind = "json-document";
      } else {
        check(
          result.stdout.endsWith("\n") && result.stdout.trim().length > 0,
          `${id}: missing bare setup code`,
        );
        decodeCode(result.stdout.trim(), expectedUrl);
        check(
          !result.stderr.includes(result.stdout.trim()),
          `${id}: bare setup code duplicated on stderr`,
        );
        if (scenario.lan)
          check(
            result.stderr.includes("setup code was limited for safety"),
            `${id}: missing existing LAN warning`,
          );
        outputKind = "bare-code";
      }
      records.push({
        id,
        exitCode: result.status,
        outputKind,
        stdoutBytes: Buffer.byteLength(result.stdout),
        passed: true,
      });
    }
  }
  const verdict = { mode, passed: true, cases: records, syntheticStateRemoved: true };
  await rm(proofHome, { recursive: true, force: true });
  await writeFile(
    path.join(evidenceDir, `qr-${mode}-verdict.json`),
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
  console.log(
    `QR_OUTPUT_${mode.toUpperCase()}_CONFIRMED: ${records.length} built-CLI cases; bootstrap values omitted; temporary state removed`,
  );
} finally {
  await rm(proofHome, { recursive: true, force: true });
}
