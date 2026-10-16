import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStaticReviewHarnessAdapter } from '../src/adapters/harness/static-review.js';
import { policyVersion } from '../src/core/audit.js';
import { preflightFiles } from '../src/core/preflight.js';
import { prepareReviewInputs } from '../src/core/prepare-review.js';

const defaultPolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));

function fixture(content = 'export const value = 1;\n') {
  const policy = structuredClone(defaultPolicy);
  policy.dataPolicy.selectedProvider = 'lm-studio-local';
  policy.dataPolicy.allowedProviders = ['lm-studio-local'];
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'synthetic/example.js', changeType: 'added', content },
  ] } }, policy);
  return { policy, bundle };
}

test('static review harness binds a deeply frozen snapshot and policy', () => {
  const { policy, bundle } = fixture();
  const harness = createStaticReviewHarnessAdapter({ policy, bundle });
  const capability = harness.verifyRuntime();
  assert.equal(capability.adapterType, 'harness');
  assert.equal(Object.values(capability.controls).every((state) => state === 'enforced'), true);
  harness.assertScope({ policyVersion: policyVersion(policy), reviewId: bundle.reviewId,
    snapshotSha256: bundle.snapshot.sha256, mode: bundle.mode, reviewers: bundle.reviewers });
  assert.throws(() => harness.assertScope({ policyVersion: policyVersion(policy),
    reviewId: bundle.reviewId, snapshotSha256: '0'.repeat(64),
    mode: bundle.mode, reviewers: bundle.reviewers }),
  (error) => error.code === 'HARNESS_SCOPE_CHANGED');
  policy.budgets.maxModelCalls++;
  assert.throws(() => harness.verifyRuntime(), (error) => error.code === 'HARNESS_SCOPE_CHANGED');
});

test('static review harness refuses a different bundle before model request preparation', async () => {
  const first = fixture();
  const second = fixture('export const value = 2;\n');
  const harnessAdapter = createStaticReviewHarnessAdapter(first);
  let prepares = 0;
  const modelAdapter = { prepareRequest: () => { prepares++; throw new Error('unexpected'); } };
  await assert.rejects(() => prepareReviewInputs(second.policy, second.bundle,
    { harnessAdapter, modelAdapter }), (error) => error.code === 'ADAPTER_FAILED');
  assert.equal(prepares, 0);
});
