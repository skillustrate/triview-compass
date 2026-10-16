import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAuditRecord, policyVersion } from '../src/core/audit.js';
import { preflightFiles } from '../src/core/preflight.js';

const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));
const secret = 'AKIAABCDEFGHIJKLMNOP';
const sourcePath = 'src/private-example.js';
const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
  { path: sourcePath, changeType: 'added', content: `const token = '${secret}';\n` },
] } }, policy);
const completed = [
  { role: 'code-quality', status: 'completed' },
  { role: 'security', status: 'completed' },
  { role: 'performance', status: 'completed' },
];

test('policy version is stable across object key ordering', () => {
  const reversed = Object.fromEntries(Object.entries(policy).reverse());
  assert.equal(policyVersion(policy), policyVersion(reversed));
});

test('audit record contains metadata and no source or paths', () => {
  const record = createAuditRecord(bundle, policy, {
    event: 'review-finished', reviewerStatuses: completed,
    findingsCount: 0, validationStatus: 'valid', sandboxStatus: 'not-requested',
  });
  assert.equal(record.scopeCounts.included, 1);
  assert.equal(record.policyVersion, policyVersion(policy));
  const output = JSON.stringify(record);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(sourcePath), false);
  assert.equal(output.includes('REDACTED'), false);
});

test('audit refuses to label an incomplete reviewer set as finished', () => {
  const statuses = structuredClone(completed);
  statuses[1].status = 'failed';
  assert.throws(() => createAuditRecord(bundle, policy, {
    event: 'review-finished', reviewerStatuses: statuses,
    findingsCount: 0, validationStatus: 'valid', sandboxStatus: 'not-requested',
  }), (error) => error.code === 'INVALID_AUDIT');
});
