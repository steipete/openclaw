// Exact native ownership diagnostics can survive as text after a wrapper returns exit 1.
export function classifyNativeRetention(streams) {
  const diagnostics = [
    [
      "vitest-worker-join",
      /^\[vitest-workers\] retaining [^\n]+: (?:compiler|borrower) join failed$/,
    ],
    [
      "vitest-namespace",
      /^\[vitest\] retained temporary namespace [^\n]+; (?:descendant completion is unverified on this non-group launch|child\/group or nested resource completion was not verified)\. Stop the remaining writers before removing this exact directory\.$/,
    ],
    [
      "vitest-process-group",
      /^\[vitest\] process group (?:\d+|unknown) remained alive \d+ms after SIGKILL; members: /,
    ],
    [
      "managed-closure",
      /^Managed command cleanup could not verify child, process group, and output closure$/,
    ],
    ["windows-closure", /^Windows taskkill could not verify managed process tree exit$/],
    ["dist-artifact-closure", /^\[dist artifacts\] child cleanup unverified; retained [^\n]+$/],
    ["vitest-resource-claim", /^Unreleased Vitest resource claim: [^\n]+$/],
  ];
  return Object.entries(streams).flatMap(([stream, output]) =>
    output
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      .split("\n")
      .flatMap((raw) => {
        const line = raw
          .trim()
          .replace(/^\[cause\]: /, "")
          .replace(/^Error(?: \[[^\]\n]+\])?: /, "");
        return diagnostics
          .filter(([, pattern]) => pattern.test(line))
          .map(([kind]) => ({ stream, kind, line }));
      }),
  );
}
