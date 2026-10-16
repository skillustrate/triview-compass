import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport } from '../src/cli/format-report.js';

test('readable findings retain validation gaps and neutralize terminal control sequences', () => {
  const report = { status: 'incomplete', verdict: 'incomplete', snapshotSha256: 'a'.repeat(64),
    reviewers: [{ role: 'security', status: 'failed', reason: 'One finding could not be verified.' }],
    coverage: { includedPaths: ['a.js'], excludedPaths: ['.env'], skippedChecks: ['Sandbox execution skipped.'] },
    findings: [{ severity: 'Required', title: 'Missing check\u001b[2J', impact: 'Unauthorized access',
      evidence: { path: 'a.js', startLine: 3 }, disagreement: true }],
    unverifiableFindings: [{ title: 'Unknown anchor', reason: 'unknown-file-id' }],
    limitations: ['Partial evidence\u202e'], sandbox: { status: 'skipped', reason: 'Podman missing' } };
  const text = formatReport(report);
  assert.match(text, /Review: incomplete; verdict: incomplete/u);
  assert.match(text, /Coverage: 1 included, 1 excluded/u);
  assert.match(text, /Required: Missing check\\u001b\[2J \(a.js:3\)/u);
  assert.match(text, /Unverifiable: Unknown anchor/u);
  assert.match(text, /severity disagreement retained/u);
  assert.match(text, /Skipped: Sandbox execution skipped/u);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(text.includes('\u202e'), false);
  assert.ok(text.includes('\\u202e'));
});
