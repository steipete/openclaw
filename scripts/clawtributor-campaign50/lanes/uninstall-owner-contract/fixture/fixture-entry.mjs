#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("0.0.0-synthetic-owner-proof\n");
} else {
  process.stdout.write(JSON.stringify({ fixture: "127254-owner-contract", args }) + "\n");
}
