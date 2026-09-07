import assert from "node:assert/strict";

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one diagnostic anchor: ${before}`);
  return source.replace(before, after);
}

export function instrumentGrowth(source, directory) {
  const anchor = "    const createPlanWithInventory = async (\n";
  source = replaceOnce(
    source,
    anchor,
    `    const __proofFs = await import("node:fs");
    const __proofOwners = new WeakMap();
    let __proofNextOwner = 0;
    let __proofOrdinal = 0;
${anchor}`,
  );
  const start = `      extraFiles: string[] = [],
    ) => {
      vi.resetModules();`;
  source = replaceOnce(
    source,
    start,
    `      extraFiles: string[] = [],
    ) => {
      const __proofStart = performance.now();
      vi.resetModules();`,
  );
  const plan = `        return createPlan(options);`;
  source = replaceOnce(
    source,
    plan,
    `        const __proofImported = performance.now();
        const __proofPlan = createPlan(options);
        const __proofPacked = performance.now();
        const __proofOwner = (await import("../vitest/vitest.unit-fast-paths.mjs")).getUnitFastTestFiles;
        if (!__proofOwners.has(__proofOwner)) __proofOwners.set(__proofOwner, ++__proofNextOwner);
        const __proofBytes = JSON.stringify(__proofPlan);
        if (Buffer.byteLength(__proofBytes) > 16_000_000) throw new Error("Diagnostic plan exceeds bound");
        __proofFs.writeFileSync(${JSON.stringify(directory)} + "/plan-" + __proofOrdinal + ".json", __proofBytes, { flag: "wx" });
        __proofFs.writeFileSync(${JSON.stringify(directory)} + "/row-" + __proofOrdinal + ".json", JSON.stringify({
          ordinal: __proofOrdinal, includeGrowthFile, extraFiles, pid: process.pid,
          owner: __proofOwners.get(__proofOwner),
          importMs: __proofImported - __proofStart, packingMs: __proofPacked - __proofImported,
        }), { flag: "wx" });
        __proofOrdinal += 1;
        return __proofPlan;`,
  );
  return source;
}

export function orderTooling(source, sequencer) {
  source = replaceOnce(
    source,
    "  return createScopedVitestConfig(",
    "  const config = createScopedVitestConfig(",
  );
  return replaceOnce(
    source,
    "  });\n}\n",
    `  });
  config.test.sequence = { ...config.test.sequence, sequencer: ${JSON.stringify(sequencer)} };
  return config;
}
`,
  );
}
