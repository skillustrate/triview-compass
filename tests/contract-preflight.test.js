import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preflightFiles } from '../src/core/preflight.js';
import { assertModelPreflight } from '../src/core/model-preflight.js';

const defaultPolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));
const request = { contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'src/a.js', changeType: 'added', content: 'export {};\n' },
] } };

const enforcedHarness = {
  contractVersion: '1.0', adapterId: 'harness-1', adapterType: 'harness',
  adapterVersion: '1.0', limitations: [], controls: {
    readOnlyInput: 'enforced', noAgentWrite: 'enforced', noAgentExecution: 'enforced',
    noAgentNetwork: 'enforced', freshContextPerReviewer: 'enforced',
    crossSessionMemoryDisabled: 'enforced',
  },
};
const localModel = {
  contractVersion: '1.0', adapterId: 'model-1', adapterType: 'model',
  adapterVersion: '1.0', providerId: 'local-1', modelId: 'model-1',
  dataHandling: 'local', contextWindowTokens: 20000, maxOutputTokens: 2000,
  limitations: [], controls: {
    freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
    structuredOutput: 'unsupported', usageReporting: 'unsupported',
  },
};
const bounds = { 'code-quality': 1000, security: 1100, performance: 900 };

function configuredPolicy() {
  const policy = structuredClone(defaultPolicy);
  policy.dataPolicy.allowedProviders = ['local-1'];
  policy.dataPolicy.selectedProvider = 'local-1';
  return policy;
}

test('request and policy reject unknown fields before capture', () => {
  assert.throws(() => preflightFiles({ ...request, untrusted: 'x' }, defaultPolicy),
    (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => preflightFiles(request, { ...defaultPolicy, untrusted: 'x' }),
    (error) => error.code === 'INVALID_POLICY');
  const invalid = structuredClone(defaultPolicy);
  delete invalid.dataPolicy;
  assert.throws(() => preflightFiles(request, invalid),
    (error) => error.code === 'INVALID_POLICY');
});

test('model preflight requires selected allowlisted provider and exact adapter identity', () => {
  assert.throws(() => assertModelPreflight(defaultPolicy, {
    harness: enforcedHarness, model: localModel, inputTokenBounds: bounds,
  }), (error) => error.code === 'PROVIDER_NOT_ALLOWED');
  const policy = configuredPolicy();
  assert.throws(() => assertModelPreflight(policy, {
    harness: enforcedHarness, model: { ...localModel, providerId: 'other' }, inputTokenBounds: bounds,
  }), (error) => error.code === 'PROVIDER_MISMATCH');
});

test('model preflight refuses unenforced controls and mismatched data handling', () => {
  const policy = configuredPolicy();
  const harness = structuredClone(enforcedHarness);
  harness.controls.noAgentNetwork = 'configurable';
  assert.throws(() => assertModelPreflight(policy, { harness, model: localModel, inputTokenBounds: bounds }),
    (error) => error.code === 'CAPABILITY_UNAVAILABLE');
  assert.throws(() => assertModelPreflight(policy, {
    harness: enforcedHarness, model: { ...localModel, dataHandling: 'hosted' }, inputTokenBounds: bounds,
  }), (error) => error.code === 'DATA_HANDLING_MISMATCH');
});

test('model preflight requires conservative bounds for every reviewer', () => {
  const policy = configuredPolicy();
  assert.throws(() => assertModelPreflight(policy, {
    harness: enforcedHarness, model: localModel, inputTokenBounds: { security: 1000 },
  }), (error) => error.code === 'TOKEN_BOUNDS_UNAVAILABLE');
  assert.throws(() => assertModelPreflight(policy, {
    harness: enforcedHarness, model: localModel,
    inputTokenBounds: { ...bounds, security: policy.budgets.maxInputTokensPerReviewer + 1 },
  }), (error) => error.code === 'BUDGET_EXCEEDED');
  const result = assertModelPreflight(policy, {
    harness: enforcedHarness, model: localModel, inputTokenBounds: bounds,
  });
  assert.equal(result.providerId, 'local-1');
  assert.equal(result.limitations.length, 2);
});
