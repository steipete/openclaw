// Inert remote-proof driver until the owning review authorizes execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sourceDir, artifactDir] = process.argv.slice(2);
assert.ok(path.isAbsolute(sourceDir));
assert.ok(path.isAbsolute(artifactDir));
assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
const proofRoot = await fs.mkdtemp(path.join(process.env.TMPDIR, "staging-ordinary-"));
const home = path.join(proofRoot, "home");
const state = path.join(home, ".openclaw");
const inbound = path.join(state, "media", "inbound");
await fs.mkdir(inbound, { recursive: true });
await fs.mkdir(artifactDir, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = path.join(state, "openclaw.json");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  "base64",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const observations = [];
const failures = [];
let cleaned = false;
const check = (condition, code) => {
  if (!condition) failures.push(code);
};
const list = async (directory) => {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
};
try {
  const { stageSandboxMedia } = await import(
    pathToFileURL(path.join(sourceDir, "src/auto-reply/reply/stage-sandbox-media.ts")).href
  );
  const { hydratePromptMediaMessages } = await import(
    pathToFileURL(path.join(sourceDir, "src/agents/embedded-agent-runner/run/images.ts")).href
  );
  for (const [name, slots] of [
    ["missing-only", ["missing"]],
    ["success", ["valid"]],
    ["missing-then-valid", ["missing", "valid"]],
    ["valid-then-missing", ["valid", "missing"]],
  ]) {
    const workspaceDir = path.join(proofRoot, name);
    await fs.mkdir(workspaceDir);
    const projectFile = path.join(workspaceDir, "keep.txt");
    await fs.writeFile(projectFile, "unrelated project bytes");
    const media = [];
    for (const [index, kind] of slots.entries()) {
      const sourcePath = path.join(inbound, `${name}-${index}.png`);
      await fs.writeFile(sourcePath, tinyPng);
      if (kind === "missing") await fs.unlink(sourcePath);
      media.push({ path: sourcePath, kind: "image", contentType: "image/png" });
    }
    const original = structuredClone(media);
    const ctx = { media };
    const sessionCtx = { media: structuredClone(media) };
    const cfg = {
      agents: {
        defaults: { workspace: workspaceDir, sandbox: { mode: "off" } },
        entries: { main: { workspace: workspaceDir } },
      },
    };
    const result = await stageSandboxMedia({
      ctx,
      sessionCtx,
      cfg,
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir,
    });
    const expectedSlots = slots.flatMap((slot, index) => (slot === "valid" ? [index] : []));
    check(
      JSON.stringify([...result.staged.keys()]) === JSON.stringify(expectedSlots),
      `${name}:positional-results`,
    );
    check(JSON.stringify(ctx.media) === JSON.stringify(sessionCtx.media), `${name}:session-facts`);
    check(
      (await fs.readFile(projectFile, "utf8")) === "unrelated project bytes",
      `${name}:project-preserved`,
    );
    const directories = (await list(path.join(workspaceDir, "media", "inbound"))).filter((entry) =>
      entry.startsWith("openclaw-staged-"),
    );
    check(directories.length === (expectedSlots.length ? 1 : 0), `${name}:staging-directory-count`);
    const successfulHashes = [];
    for (const [index, slot] of slots.entries()) {
      if (slot === "missing") {
        check(
          JSON.stringify(ctx.media[index]) === JSON.stringify(original[index]),
          `${name}:missing-facts-${index}`,
        );
        continue;
      }
      const stagedPath = result.staged.get(index);
      assert.equal(typeof stagedPath, "string");
      check(
        /^media\/inbound\/openclaw-staged-[0-9a-f-]+\/input-/.test(
          path.relative(workspaceDir, stagedPath).split(path.sep).join("/"),
        ),
        `${name}:path-shape-${index}`,
      );
      check(
        ctx.media[index].path === stagedPath &&
          ctx.media[index].workspaceDir === workspaceDir &&
          ctx.media[index].staged === true,
        `${name}:staged-facts-${index}`,
      );
      const bytes = await fs.readFile(stagedPath);
      check(bytes.equals(tinyPng), `${name}:staged-bytes-${index}`);
      const marker = await fs.readFile(path.join(path.dirname(stagedPath), ".gitignore"), "utf8");
      check(
        marker ===
          "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n",
        `${name}:privacy-marker-${index}`,
      );
      successfulHashes.push(digest(bytes));
    }
    let hydratedHashes = [];
    if (expectedSlots.length) {
      // Serialize the actual staged facts before rehydration, as transcript replay does.
      const persisted = JSON.parse(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "synthetic attachment replay" }],
          timestamp: 1,
          __openclaw: { media: ctx.media },
        }),
      );
      const hydrated = await hydratePromptMediaMessages([persisted], {
        workspaceDir,
        workspaceOnly: true,
        model: { input: ["text", "image"] },
      });
      const content = hydrated[0]?.content;
      const images = Array.isArray(content)
        ? content.filter((block) => block.type === "image")
        : [];
      hydratedHashes = images.map((image) => digest(Buffer.from(image.data, "base64")));
      check(
        images.length === expectedSlots.length &&
          images.every((image) => image.mimeType === "image/png"),
        `${name}:hydrated-images`,
      );
      check(
        JSON.stringify(hydratedHashes) === JSON.stringify(successfulHashes),
        `${name}:hydrated-bytes`,
      );
    }
    observations.push({
      name,
      expectedSlots,
      actualSlots: [...result.staged.keys()],
      stagingDirectoryCount: directories.length,
      successfulHashes,
      hydratedHashes,
    });
  }
} catch (error) {
  failures.push(`unexpected:${error instanceof Error ? error.message : String(error)}`);
} finally {
  await fs.rm(proofRoot, { recursive: true, force: true });
  cleaned = true;
  await fs.writeFile(
    path.join(artifactDir, "ordinary-staging.json"),
    JSON.stringify(
      {
        driverSha256: digest(await fs.readFile(import.meta.filename)),
        stagingOwnerSha256: digest(
          await fs.readFile(path.join(sourceDir, "src/auto-reply/reply/stage-sandbox-media.ts")),
        ),
        observations,
        failures,
        cleaned,
        interpretation:
          "Real staging and image hydration with small owned files; no model/provider/Gateway or queue-cleanup claim.",
      },
      null,
      2,
    ) + "\n",
  );
}
process.exitCode = failures.length ? 1 : 0;
