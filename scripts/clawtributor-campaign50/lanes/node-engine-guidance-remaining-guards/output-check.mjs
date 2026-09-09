import assert from "node:assert/strict";
// Native disposal errors can follow a completed test report without changing red exit 1.
export function nativeOwnershipUncertainty(output) {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const diagnostics = [
    /^(?:Error: )?\[vitest\] retained temporary namespace [^\n]+; (?:descendant completion is unverified on this non-group launch|child\/group or nested resource completion was not verified)\. Stop the remaining writers before removing this exact directory\.$/,
    /^\[vitest-workers\] retaining [^\n]+: (?:compiler|borrower) join failed$/,
    /^(?:Error: )?\[vitest\] process group (?:\d+|unknown) remained alive \d+ms after SIGKILL; members: /,
    /^\[vitest-pool\]: (?:Timeout terminating|Failed to terminate) [^\n]+ worker for test files /,
    /^(?:Error: )?Managed command cleanup could not verify child, process group, and output closure$/,
    /^(?:Error: )?Windows taskkill could not verify managed process tree exit$/,
  ];
  return clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const nativeError = /^\[?(?:[A-Za-z_$][\w$]*)?Error(?: \[[^\]\n]+\])?:/.test(line);
      return diagnostics.some((pattern) => pattern.test(line)) || nativeError;
    })
    .slice(0, 20);
}

export function verifyOutput(check, stdout, stderr) {
  assert.equal(stdout, check.stdout, `${check.id}: unexpected stdout`);
  assert.equal(stderr, "", `${check.id}: unexpected stderr`);
}
