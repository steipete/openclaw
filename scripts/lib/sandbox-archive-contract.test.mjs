import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeSandboxArchive,
  createSandboxArchiveEntryValidator,
} from "./sandbox-archive-contract.mjs";

const limits = {
  archiveLabel: "fixture.tar.gz",
  maxEntries: 3,
  maxEntryBytes: 8,
  maxUnpackedBytes: 12,
};

function validate(entries, overrides = {}) {
  const accept = createSandboxArchiveEntryValidator({ ...limits, ...overrides });
  for (const entry of entries) {
    accept({ size: 0, ...entry });
  }
}

test("accepts bounded regular files and directories", () => {
  validate([
    { type: "Directory", path: "package/" },
    { type: "File", path: "package/index.js", size: 8 },
  ]);
});

test("rejects links, devices, and FIFOs", () => {
  for (const type of ["Link", "SymbolicLink", "CharacterDevice", "BlockDevice", "FIFO"]) {
    assert.throws(() => validate([{ type, path: "package/unsafe" }]), /forbidden/u);
  }
});

test("rejects unsafe and duplicate normalized paths", () => {
  for (const unsafePath of ["/absolute", "../traversal", "package/../traversal", "C:\\drive"]) {
    assert.throws(() => validate([{ type: "File", path: unsafePath }]), /unsafe|absolute/u);
  }
  assert.throws(
    () =>
      validate([
        { type: "File", path: "./package/index.js" },
        { type: "File", path: "package/index.js" },
      ]),
    /repeats/u,
  );
});

test("rejects per-entry, aggregate, and entry-count overages", () => {
  assert.throws(
    () => validate([{ type: "File", path: "large", size: 9 }]),
    /entry exceeds size limit/u,
  );
  assert.throws(
    () =>
      validate([
        { type: "File", path: "one", size: 7 },
        { type: "File", path: "two", size: 6 },
      ]),
    /unpacked size limit/u,
  );
  assert.throws(
    () =>
      validate([
        { type: "File", path: "one" },
        { type: "File", path: "two" },
        { type: "File", path: "three" },
        { type: "File", path: "four" },
      ]),
    /archive entry limit/u,
  );
});

test("archive scanner rejects symbolic and hard links", async (context) => {
  const { create } = await import("tar");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sandbox-archive-contract-"));
  context.after(() => rm(tempDir, { recursive: true, force: true }));
  const payloadDir = path.join(tempDir, "payload");
  await mkdir(payloadDir);
  await writeFile(path.join(payloadDir, "file.txt"), "safe\n");
  await symlink("file.txt", path.join(payloadDir, "symbolic.txt"));
  await link(path.join(payloadDir, "file.txt"), path.join(payloadDir, "hard.txt"));
  const archivePath = path.join(tempDir, "fixture.tar.gz");
  await create({ cwd: tempDir, file: archivePath, gzip: true }, ["payload"]);
  await assert.rejects(
    assertSafeSandboxArchive({
      archivePath,
      archiveLabel: "fixture.tar.gz",
      limits: {
        maxEntries: 100,
        maxEntryBytes: 1024,
        maxUnpackedBytes: 4096,
      },
    }),
    /forbidden (?:SymbolicLink|Link) entry/u,
  );
});
