import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [target, lane, destination] = process.argv.slice(2);
assert.equal(process.cwd(), target);
const { computeBaseConfigSchemaResponse } = await import(
  pathToFileURL(path.join(target, "src/config/schema-base.ts")).href
);
const { OpenClawSchema } = await import(
  pathToFileURL(path.join(target, "src/config/zod-schema.ts")).href
);
const fixtures = JSON.parse(await fs.readFile(path.join(lane, "fixtures.json"), "utf8"));
const source = JSON.parse(await fs.readFile(path.join(lane, "MANIFEST.json"), "utf8")).source;
const schemaResponse = computeBaseConfigSchemaResponse({ generatedAt: "2026-09-07T00:00:00.000Z" });
assert.equal(
  schemaResponse.uiHints["gateway.publicOrigin"].placeholder,
  "https://gateway.example.com",
);
assert.equal(schemaResponse.uiHints["gateway.controlUi.basePath"].placeholder, "/openclaw");
assert.equal(schemaResponse.uiHints["cron.enabled"]?.placeholder, undefined);
assert.equal(schemaResponse.uiHints["cron.triggers.enabled"]?.placeholder, undefined);
const cron = schemaResponse.schema.properties.cron;
assert.equal(cron.properties.enabled.type, "boolean");
assert.equal(cron.properties.triggers.properties.enabled.type, "boolean");
assert.ok(!cron.required?.includes("enabled"));
assert.ok(!cron.properties.triggers.required?.includes("enabled"));
assert.ok(!Object.hasOwn(cron.properties.enabled, "default"));
assert.ok(!Object.hasOwn(cron.properties.triggers.properties.enabled, "default"));
const validation = fixtures.map(({ id, config }) => {
  const parsed = OpenClawSchema.safeParse(config);
  assert.equal(parsed.success, true, `Invalid fixture ${id}`);
  assert.equal(parsed.data.cron?.enabled, config.cron?.enabled);
  assert.equal(parsed.data.cron?.triggers?.enabled, config.cron?.triggers?.enabled);
  return { id, valid: true };
});
await fs.writeFile(
  destination,
  `${JSON.stringify({ source, schemaResponse, fixtures, validation }, null, 2)}\n`,
);
