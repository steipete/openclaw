import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, configPath, reportPath] = process.argv.slice(2);
assert(repo && configPath && reportPath);
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const { noteBootstrapFileSize } = await import(
  pathToFileURL(path.join(repo, "src/commands/doctor-bootstrap-size.ts")).href
);
const analysis = await noteBootstrapFileSize(config);
assert(analysis);
await fs.writeFile(reportPath, JSON.stringify(analysis, null, 2) + "\n");
