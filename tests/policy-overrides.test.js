import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyPolicyOverrides } from '../src/core/policy-overrides.js';

const basePolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));

test('applying zero overrides is a no-op other than contractVersion', () => {
  const merged = applyPolicyOverrides(basePolicy, { contractVersion: '1.0' });
  assert.deepEqual(merged, basePolicy);
  assert.notEqual(merged, basePolicy, 'must return a copy, not the same object');
});

test('budgets are merged key by key, leaving every other budget field untouched', () => {
  const merged = applyPolicyOverrides(basePolicy,
    { contractVersion: '1.0', budgets: { maxInputTokensPerReviewer: 300000 } });
  assert.equal(merged.budgets.maxInputTokensPerReviewer, 300000);
  assert.equal(merged.budgets.maxFiles, basePolicy.budgets.maxFiles);
  assert.equal(merged.budgets.timeoutSeconds, basePolicy.budgets.timeoutSeconds);
});

test('pathPolicy.excludedPathGlobs replaces rather than appends', () => {
  const policy = structuredClone(basePolicy);
  policy.pathPolicy.excludedPathGlobs = ['old/**'];
  const merged = applyPolicyOverrides(policy,
    { contractVersion: '1.0', pathPolicy: { excludedPathGlobs: ['new/**', 'also/**'] } });
  assert.deepEqual(merged.pathPolicy.excludedPathGlobs, ['new/**', 'also/**']);
  assert.deepEqual(merged.pathPolicy.generatedPathGlobs, policy.pathPolicy.generatedPathGlobs);
});

test('a reviewer subset recomputes mode to partial and reorders canonically', () => {
  const merged = applyPolicyOverrides(basePolicy,
    { contractVersion: '1.0', reviewers: ['performance', 'security'] });
  assert.deepEqual(merged.reviewers, ['security', 'performance']);
  assert.equal(merged.mode, 'partial');
  assert.equal(merged.budgets.maxModelCalls, basePolicy.budgets.maxModelCalls);
});

test('all three reviewers recomputes mode to full', () => {
  const merged = applyPolicyOverrides(basePolicy,
    { contractVersion: '1.0', reviewers: ['performance', 'security', 'code-quality'] });
  assert.deepEqual(merged.reviewers, ['code-quality', 'security', 'performance']);
  assert.equal(merged.mode, 'full');
});

test('sandbox override replaces the whole object, not merged key by key', () => {
  const merged = applyPolicyOverrides(basePolicy, { contractVersion: '1.0',
    sandbox: { executionRequested: true, backend: 'podman', network: 'disabled' } });
  assert.deepEqual(merged.sandbox, { executionRequested: true, backend: 'podman', network: 'disabled' });
});

test('an invalid override document is rejected before any merge happens', () => {
  assert.throws(() => applyPolicyOverrides(basePolicy, { contractVersion: '1.0', reviewers: [] }),
    /INVALID_POLICY_OVERRIDES/u);
  assert.throws(() => applyPolicyOverrides(basePolicy, { contractVersion: '1.0', budgets: { maxFiles: 0 } }),
    /INVALID_POLICY_OVERRIDES/u);
  assert.throws(() => applyPolicyOverrides(basePolicy, { contractVersion: '1.0', unknownField: true }),
    /INVALID_POLICY_OVERRIDES/u);
  assert.throws(() => applyPolicyOverrides(basePolicy,
    { contractVersion: '1.0', sandbox: { executionRequested: true, backend: 'none', network: 'disabled' } }),
    /INVALID_POLICY_OVERRIDES/u);
});

test('an override that would produce an invalid merged policy is still rejected', () => {
  const policy = structuredClone(basePolicy);
  policy.budgets.maxModelCalls = 3;
  assert.throws(() => applyPolicyOverrides(policy,
    { contractVersion: '1.0', reviewers: ['code-quality', 'security', 'performance'],
      budgets: { maxModelCalls: 1 } }),
    /INVALID_POLICY/u);
});

test('a non-object base policy is rejected the same way review.js already rejects one', () => {
  assert.throws(() => applyPolicyOverrides({ not: 'a policy' }, { contractVersion: '1.0' }),
    /INVALID_POLICY/u);
});
