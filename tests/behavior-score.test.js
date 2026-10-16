import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreBehaviorCase } from '../evals/scripts/score-behavior.js';

const oracle = { id: 'sql', reviewer: 'security', path: 'a.js', startLine: 2, endLine: 2,
  pattern: 'sql|injection', categories: ['security'] };
const spec = { expectedFindings: [oracle], expectZeroFindings: false };
function report({ path = 'a.js', line = 2, reviewer = 'security', baseline = false, findings = true } = {}) {
  const item = { id: 'finding-1', category: 'security', severity: 'Required', title: 'SQL injection', impact: 'Unsafe query',
    evidence: { path, startLine: line, endLine: line }, disagreement: false,
    sourceFindings: [{ reviewer, findingId: 'sql', severity: 'Required', confidence: 1 }] };
  return { contractVersion: '1.0', reviewId: 'review-test', snapshotSha256: 'a'.repeat(64),
    mode: baseline ? 'partial' : 'full', status: baseline ? 'partial' : 'complete',
    verdict: findings ? 'request-changes' : 'recommend-approval',
    reviewers: ['code-quality', 'security', 'performance'].map((role) => baseline && role !== 'code-quality'
      ? { role, status: 'omitted', reason: 'Explicit baseline' }
      : { role, status: 'completed', adapter: { adapterId: 'test', providerId: 'test', modelId: 'test' },
        invocationId: `invocation-${role}`, contextId: `context-${role}` }),
    findings: findings ? [item] : [], unverifiableFindings: [],
    coverage: { includedPaths: ['a.js'], excludedPaths: [], skippedChecks: [] }, limitations: [] };
}

test('behavior scorer requires anchored expected findings and correct full-review attribution', () => {
  assert.equal(scoreBehaviorCase(spec, report()).passed, true);
  assert.equal(scoreBehaviorCase(spec, report({ path: 'other.js' })).passed, false);
  assert.equal(scoreBehaviorCase(spec, report({ line: 5 })).passed, false);
  assert.equal(scoreBehaviorCase(spec, report({ reviewer: 'code-quality' })).passed, false);
  assert.equal(scoreBehaviorCase(spec, report({ findings: false })).passed, false);
  assert.equal(scoreBehaviorCase(spec, report({ reviewer: 'code-quality', baseline: true }), { baseline: true }).passed, true);
});

test('behavior scorer distinguishes clean false alerts and performance specialty violations', () => {
  const clean = { expectedFindings: [], expectZeroFindings: true };
  assert.equal(scoreBehaviorCase(clean, report({ findings: false })).passed, true);
  assert.equal(scoreBehaviorCase(clean, report()).cleanFalseAlerts, 1);
  assert.equal(scoreBehaviorCase(clean, report()).passed, false);
  assert.equal(scoreBehaviorCase(spec, report({ reviewer: 'performance' })).performanceOffScopeFindings, 1);
});

test('semantic anchor oracle rejects wrong existing lines and ranges that merely span the defect', () => {
  const numbered = { expectedFindings: [{ ...oracle, startLine: 43, endLine: 43, maxEvidenceLines: 2 }], expectZeroFindings: false };
  assert.equal(scoreBehaviorCase(numbered, report({ line: 43 })).passed, true);
  assert.equal(scoreBehaviorCase(numbered, report({ line: 42 })).passed, false);
  const broad = report({ line: 1 });
  broad.findings[0].evidence.endLine = 50;
  assert.equal(scoreBehaviorCase(numbered, broad).passed, false);
  const mixed = report({ line: 43 });
  mixed.findings.push({ ...report({ line: 42 }).findings[0], id: 'finding-2' });
  assert.equal(scoreBehaviorCase(numbered, mixed).semanticAnchorViolations, 1);
  assert.equal(scoreBehaviorCase(numbered, mixed).passed, false);
  assert.equal(scoreBehaviorCase({ expectedFindings: [], expectZeroFindings: true }, report()).passed, false);
});
