import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const require = createRequire(path.join(process.cwd(), "package.json"));
const tar = require("tar");
const { observeBackupTarEntryProgress, writeArchiveStreamToFile } = await import(
  pathToFileURL(path.resolve("src/infra/backup-create-stream.ts")).href
);
const { writeTarArchiveWithRetry } = await import(
  pathToFileURL(path.resolve("src/infra/backup-tar-retry.ts")).href
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-unicode-proof-"));
const tail = `${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`;
assert.equal(tail.length, 511);
const cases = [
  { name: "ascii", relative: "source/stalled.pack" },
  { name: "unicode-intact", relative: "source/🤖/stalled.pack" },
  { name: "unicode-boundary", relative: `source/🤖${tail}`, expected: tail },
];
let unicodeFailure = false;
try {
  for (const item of cases) {
    const source = path.join(root, item.relative);
    const expected = item.expected ?? source;
    for (const component of item.relative.split("/")) {
      assert.ok(Buffer.byteLength(component) <= 255, "fixture must fit real filesystem components");
    }
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "synthetic backup payload\n");
    const archivePath = path.join(root, `${item.name}.tar.gz`);
    const stalled = new PassThrough();
    let attempts = 0;
    let observedSource: string | undefined;
    let rawBytes = 0;
    let tarEnded = false;
    let error: Error | undefined;
    try {
      await writeTarArchiveWithRetry({
        tempArchivePath: archivePath,
        runTar: (attemptPath: string) => {
          attempts += 1;
          return writeArchiveStreamToFile({
            archivePath: attemptPath,
            idleTimeoutMs: 250,
            createArchiveStream: (report: (progress: object) => void) => {
              const pack = tar.c(
                {
                  gzip: true,
                  portable: true,
                  preservePaths: true,
                  filter: (entryPath: string) => {
                    report({ phase: "traversal", entryPath });
                    return true;
                  },
                  onWriteEntry: (entry: {
                    path: string;
                    flowing: boolean;
                    on: Function;
                    pause: Function;
                  }) => {
                    observedSource = entry.path;
                    report({ phase: "entry", entryPath: entry.path });
                    observeBackupTarEntryProgress(entry, (bytes: number) => {
                      rawBytes += bytes;
                      report({ phase: "raw", entryPath: source, bytes });
                    });
                  },
                },
                [source],
              );
              pack.on("error", (cause: Error) => stalled.destroy(cause));
              pack.on("end", () => {
                tarEnded = true;
              });
              // Fault injection only: keep the producer open after real tar bytes arrive.
              pack.pipe(stalled, { end: false });
              return stalled;
            },
          });
        },
      });
    } catch (cause) {
      assert.ok(cause instanceof Error);
      error = cause;
    }
    assert.ok(error, "stalled archive must reject");
    assert.match(error.message, /Backup archive write failed: Backup archive write stalled:/);
    assert.equal(observedSource, source, "real tar must report the actual filesystem path");
    assert.ok(rawBytes > 0, "actual entry bytes must cross the progress observer");
    assert.ok(tarEnded, "fixture must finish emitting tar bytes before injected stall");
    assert.equal(attempts, 1, "idle timeout must not become a file-race retry");
    assert.equal(stalled.destroyed, true);
    await assert.rejects(fs.lstat(archivePath), { code: "ENOENT" });
    const match = error.message.match(/entry=("(?:[^"\\]|\\.)*"), rawBytes=/);
    assert.ok(match, "timeout must carry the JSON-escaped entry diagnostic");
    const suffix = JSON.parse(match[1]);
    assert.ok(suffix.length <= 512, "diagnostic must retain its existing budget");
    const intact = suffix === expected && suffix.isWellFormed();
    if (item.name !== "unicode-boundary") {
      assert.ok(intact, `${item.name} positive control changed`);
    } else if (!intact) {
      assert.equal(
        suffix,
        `\udd16${tail}`,
        "baseline failure must be precisely the split robot surrogate",
      );
      unicodeFailure = true;
    }
    console.log(
      JSON.stringify({
        case: item.name,
        intact,
        suffixUnits: suffix.length,
        rawBytes,
        attempts,
        streamDestroyed: stalled.destroyed,
        archiveRemoved: true,
      }),
    );
  }
  const completedPath = path.join(root, "completed.tar.gz");
  const relative = cases[2].relative;
  await writeArchiveStreamToFile({
    archivePath: completedPath,
    createArchiveStream: () => tar.c({ cwd: root, gzip: true, portable: true }, [relative]),
  });
  const restored = path.join(root, "restored");
  await fs.mkdir(restored);
  await tar.x({ file: completedPath, cwd: restored });
  assert.equal(
    await fs.readFile(path.join(restored, relative), "utf8"),
    "synthetic backup payload\n",
  );
  console.log(
    JSON.stringify({ case: "completed-unicode-archive", restoredExactPathAndPayload: true }),
  );
  if (unicodeFailure) {
    console.error("BACKUP_UNICODE_BASELINE_RED: real watchdog retains a split surrogate");
    process.exitCode = 1;
  } else {
    console.log("BACKUP_UNICODE_CANDIDATE_GREEN");
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
