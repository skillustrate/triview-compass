import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReviewRequest } from '../src/core/contracts.js';
import { buildReviewRequest } from '../examples/github-actions/build-review-request.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

test('builds a schema-valid Git review request from two full commit SHAs', () => {
  const request = buildReviewRequest(BASE, HEAD);
  assert.deepEqual(request, { contractVersion: '1.0',
    input: { kind: 'git', baseRevision: BASE, targetRevision: HEAD } });
  assertReviewRequest(request);
});

test('rejects anything that is not a full 40-character lowercase hex commit SHA', () => {
  assert.throws(() => buildReviewRequest('short', HEAD), /40-character/u);
  assert.throws(() => buildReviewRequest(BASE, 'ABCDEF0000000000000000000000000000000000'), /40-character/u);
  assert.throws(() => buildReviewRequest(undefined, HEAD), /40-character/u);
  assert.throws(() => buildReviewRequest(BASE, undefined), /40-character/u);
});
