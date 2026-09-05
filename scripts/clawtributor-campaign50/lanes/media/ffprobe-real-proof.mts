import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fixtureDir = path.resolve(process.argv[2]);
const { resolveSystemBin } = await import(
  pathToFileURL(path.resolve("src/infra/resolve-system-bin.ts")).href
);
const ffprobePath = resolveSystemBin("ffprobe", { trust: "standard" });
assert.ok(ffprobePath, "system ffprobe must exist for real dependency proof");
const ffprobeVersion = execFileSync(ffprobePath, ["-version"], { encoding: "utf8" }).split("\n")[0];
console.log(JSON.stringify({ ffprobePath, ffprobeVersion }));
const { probeMediaFilesWithinBudget, probePlaybackMediaFileDescriptor, probeVideoDimensions } =
  await import(pathToFileURL(path.resolve("src/media/media-probe.ts")).href);
const { toInboundMediaFactsWithMetadata } = await import(
  pathToFileURL(path.resolve("src/channels/inbound-event/media.ts")).href
);
const audioPath = path.join(fixtureDir, "tone.flac");
const videoPath = path.join(fixtureDir, "clip.mkv");
const audio = { filePath: audioPath, kind: "audio" };
const video = { filePath: videoPath, kind: "video" };
const batch = await probeMediaFilesWithinBudget([audio, video], {
  budgetMs: 3000,
  concurrency: 2,
  maxProbes: 2,
});
const handle = await fs.open(audioPath, "r");
let playback;
try {
  playback = await probePlaybackMediaFileDescriptor(handle.fd, "audio");
} finally {
  await handle.close();
}
const inbound = await toInboundMediaFactsWithMetadata([
  { path: audioPath, contentType: "audio/flac" },
  { path: videoPath, contentType: "video/x-matroska" },
]);
const bufferDimensions = await probeVideoDimensions(await fs.readFile(videoPath));
assert.deepEqual(bufferDimensions, { width: 160, height: 96 }, "buffer pipe sibling must work");
const invalidPath = path.join(fixtureDir, "invalid.flac");
await fs.writeFile(invalidPath, "synthetic invalid media");
const invalid = await probeMediaFilesWithinBudget(
  [
    { filePath: invalidPath, kind: "audio" },
    { filePath: path.join(fixtureDir, "absent.flac"), kind: "audio" },
  ],
  { budgetMs: 3000, concurrency: 2, maxProbes: 2 },
);
assert.deepEqual(invalid, [{}, {}], "unreadable/corrupt media must remain best-effort failures");
console.log(
  JSON.stringify({
    batch,
    playback,
    inbound: inbound.map(({ durationMs, width, height }) => ({ durationMs, width, height })),
    bufferDimensions,
    invalid,
  }),
);
const broken =
  batch.every((result) => Object.keys(result).length === 0) &&
  playback === null &&
  inbound.every((result) => result.durationMs === undefined && result.width === undefined);
if (broken) {
  console.error(
    "FFPROBE_BASELINE_RED: descriptor metadata absent while buffer pipe sibling succeeds",
  );
  process.exitCode = 1;
} else {
  assert.equal(batch[0].durationMs, 1000);
  assert.equal(batch[1].durationMs, 1000);
  assert.equal(batch[1].width, 160);
  assert.equal(batch[1].height, 96);
  assert.equal(playback.durationMs, 1000);
  assert.equal(playback.audioCodec, "flac");
  assert.equal(inbound[0].durationMs, 1000);
  assert.equal(inbound[1].durationMs, 1000);
  assert.equal(inbound[1].width, 160);
  assert.equal(inbound[1].height, 96);
  console.log("FFPROBE_CANDIDATE_GREEN");
}
