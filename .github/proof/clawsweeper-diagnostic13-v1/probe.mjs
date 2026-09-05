import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [repo, casesPath, indexText, resultPath] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(casesPath, 'utf8'))[Number(indexText)];
const { dataModelChangeFromPullFilesForTest, renderReviewCommentFromReport, reviewAutomationMarkersFromReport } = await import(pathToFileURL(`${repo}/dist/clawsweeper.js`).href);
const { createReviewedPrActivityCursor } = await import(pathToFileURL(`${repo}/dist/review-activity-cursor.js`).href);
const started = performance.now();
const actual = dataModelChangeFromPullFilesForTest({ pullFiles: fixture.pullFiles });
const expected = { change: fixture.expectedSurfaces.length > 0, surfaces: fixture.expectedSurfaces };
const fields = {
  repository: 'openclaw/openclaw', type: 'pull_request', decision: 'keep_open', close_reason: 'none', confidence: 'high', action_taken: 'kept_open',
  review_lease_owner: 'fixture', review_lease_comment_id: '1059', number: '123', work_candidate: 'none', review_status: 'complete',
  labels: JSON.stringify(['clawsweeper:automerge']), pull_head_sha: 'a'.repeat(40), real_behavior_proof_status: 'sufficient', real_behavior_proof_needs_contributor_action: 'false',
  data_model_change: String(actual.change), data_model_surfaces: JSON.stringify(actual.surfaces),
  review_activity_cursor: createReviewedPrActivityCursor({ reviews: [], inlineComments: [], reviewThreads: [] }), reviewed_at: '2026-05-01T00:00:00Z',
};
const report = `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n
## Summary

Synthetic completed review; no upgrade proof is supplied.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;
const renderedWarning = renderReviewCommentFromReport(report, 'none');
const markers = reviewAutomationMarkersFromReport(report);
const observed = { name: fixture.name, actual, expected, report, renderedWarning, markers, elapsedMs: performance.now() - started, resourceUsage: process.resourceUsage(), memoryUsage: process.memoryUsage() };
// Capture the complete actual public boundary before any hypothesis assertion.
writeFileSync(resultPath, `${JSON.stringify(observed, null, 2)}\n`);
const errors = [];
for (const [boundary, check] of [
  ['classifier', () => assert.deepEqual(actual, expected)],
  ['public-warning', () => assert.equal(/Persistent data-model change detected|### Stored data model/.test(renderedWarning), expected.change)],
  ['upgrade-guidance', () => assert.equal(/Confirm migration or upgrade compatibility proof/.test(renderedWarning), expected.change)],
  ['automation-verdict', () => assert.match(markers, expected.change ? /clawsweeper-verdict:needs-human/ : /clawsweeper-verdict:pass/)],
  ['no-fix-action', () => assert.doesNotMatch(markers, /clawsweeper-action:fix-required/)],
]) {
  try { check(); } catch (error) { errors.push({ boundary, name: error.name, message: error.message }); }
}
writeFileSync(resultPath, `${JSON.stringify({ ...observed, assertionFailures: errors }, null, 2)}\n`);
assert.deepEqual(errors, []);
