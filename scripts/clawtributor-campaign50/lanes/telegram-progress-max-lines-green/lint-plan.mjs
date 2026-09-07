import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const target = process.argv[2];
const { createExtensionOxlintShards, selectExtensionOxlintStripe } = await import(
  pathToFileURL(path.join(target, "scripts/run-oxlint-shards.mts"))
);
const shards = selectExtensionOxlintStripe(createExtensionOxlintShards({ cwd: target }), {
  index: 5,
  total: 6,
});
assert(
  shards.some((shard) => shard.args.includes("extensions/telegram")),
  "Original lint stripe must include Telegram",
);
console.log(JSON.stringify(shards, null, 2));
