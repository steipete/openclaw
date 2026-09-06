function report(detection, sqlite, withProof) {
  return `---
repository: openclaw/openclaw
type: pull_request
number: 999999
decision: keep_open
close_reason: none
action_taken: kept_open
confidence: high
review_status: complete
review_lease_owner: synthetic-offline-fixture
review_lease_comment_id: 1059
reviewed_at: 2026-09-04T00:00:00Z
local_checkout_access: verified
local_checkout_access_source: runner_preflight_v1
pull_head_sha: ${"c".repeat(40)}
main_sha: ${"a".repeat(40)}
work_candidate: none
labels: ["clawsweeper:automerge"]
real_behavior_proof_status: sufficient
real_behavior_proof_needs_contributor_action: false
data_model_change: ${detection.change}
data_model_surfaces: ${JSON.stringify(detection.surfaces)}
sqlite_schema_change: ${sqlite.change}
sqlite_schema_files: ${JSON.stringify(sqlite.files)}
---

## Summary

Synthetic completed review for offline detector-to-render proof only.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none

## Solution Assessment

${
  withProof
    ? "The migration is tested against an existing database and preserves upgrade compatibility."
    : "No migration or upgrade compatibility proof supplied."
}
`;
}

function markers(comment) {
  return {
    sqliteTableWarning: comment.includes("**SQLite table change**"),
    persistedModelWarning: comment.includes("Persistent data-model change detected:"),
    compatibilityGate: comment.includes("Confirm migration or upgrade compatibility proof"),
    humanVerdict: comment.includes("clawsweeper-verdict:needs-human"),
    passVerdict: comment.includes("clawsweeper-verdict:pass"),
  };
}


export { report, markers };
