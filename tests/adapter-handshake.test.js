import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareAdapterHandshake } from '../src/core/adapter-handshake.js';
import { preflightFiles } from '../src/core/preflight.js';

const defaultPolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));

function fixture() {
  const policy = structuredClone(defaultPolicy);
  policy.dataPolicy.selectedProvider = 'local-1';
  policy.dataPolicy.allowedProviders = ['local-1'];
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/a.js', changeType: 'added', content: 'export const answer = 42;\n' },
  ] } }, policy);
  const prompts = Object.fromEntries(policy.reviewers.map((role) => [role,
    JSON.stringify({ role, snapshot: bundle.snapshot.sha256, files: bundle.files })]));
  const harnessDeclaration = {
    contractVersion: '1.0', adapterId: 'harness-1', adapterType: 'harness',
    adapterVersion: '1.0', limitations: [], controls: {
      readOnlyInput: 'enforced', noAgentWrite: 'enforced', noAgentExecution: 'enforced',
      noAgentNetwork: 'configurable', freshContextPerReviewer: 'enforced',
      crossSessionMemoryDisabled: 'enforced',
    },
  };
  const modelDeclaration = {
    contractVersion: '1.0', adapterId: 'model-1', adapterType: 'model',
    adapterVersion: '1.0', providerId: 'local-1', modelId: 'model-1',
    dataHandling: 'local', contextWindowTokens: 20000, maxOutputTokens: 2000,
    limitations: [], controls: {
      freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'configurable',
      structuredOutput: 'unsupported', usageReporting: 'unsupported',
    },
  };
  const harnessRuntime = structuredClone(harnessDeclaration);
  harnessRuntime.controls.noAgentNetwork = 'enforced';
  const modelRuntime = structuredClone(modelDeclaration);
  modelRuntime.controls.crossSessionMemoryDisabled = 'enforced';
  let prepares = 0;
  let counts = 0;
  const harnessAdapter = {
    getCapabilities: () => structuredClone(harnessDeclaration),
    verifyRuntime: () => structuredClone(harnessRuntime),
  };
  const modelAdapter = {
    getCapabilities: () => structuredClone(modelDeclaration),
    verifyRuntime: () => structuredClone(modelRuntime),
    prepareRequest: ({ role, prompt }) => {
      prepares++;
      return JSON.stringify({ role, prompt });
    },
    countInputTokens: ({ payload }) => {
      counts++;
      return { upperBound: Buffer.byteLength(payload, 'utf8'), conservative: true };
    },
  };
  return { policy, bundle, prompts, harnessRuntime, modelRuntime,
    harnessAdapter, modelAdapter, calls: () => ({ prepares, counts }) };
}

test('handshake checks active controls and counts exact prepared payloads', async () => {
  const f = fixture();
  const plan = await prepareAdapterHandshake(f.policy, f.bundle, f);
  assert.equal(plan.requests.length, 3);
  assert.equal(Object.isFrozen(plan.requests), true);
  assert.deepEqual(f.calls(), { prepares: 3, counts: 3 });
  for (const request of plan.requests) {
    assert.equal(request.payloadSha256,
      createHash('sha256').update(request.payload).digest('hex'));
    assert.equal(request.inputTokenUpperBound, Buffer.byteLength(request.payload, 'utf8'));
    assert.equal(plan.readiness.inputTokenBounds[request.role], request.inputTokenUpperBound);
  }
});

test('provider mismatch refuses before prompt text reaches model adapter', async () => {
  const f = fixture();
  f.modelAdapter.verifyRuntime = () => ({ ...f.modelRuntime, providerId: 'other' });
  await assert.rejects(() => prepareAdapterHandshake(f.policy, f.bundle, f),
    (error) => error.code === 'CAPABILITY_MISMATCH');
  assert.deepEqual(f.calls(), { prepares: 0, counts: 0 });
});

test('unselected provider refuses before any adapter operation', async () => {
  const f = fixture();
  delete f.policy.dataPolicy.selectedProvider;
  f.harnessAdapter.getCapabilities = () => { throw new Error('should not be called'); };
  await assert.rejects(() => prepareAdapterHandshake(f.policy, f.bundle, f),
    (error) => error.code === 'PROVIDER_NOT_ALLOWED');
  assert.deepEqual(f.calls(), { prepares: 0, counts: 0 });
});

test('runtime control not enforced refuses before prompt preparation', async () => {
  const f = fixture();
  f.harnessAdapter.verifyRuntime = () => ({ ...f.harnessRuntime,
    controls: { ...f.harnessRuntime.controls, noAgentNetwork: 'configurable' } });
  await assert.rejects(() => prepareAdapterHandshake(f.policy, f.bundle, f),
    (error) => error.code === 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(f.calls(), { prepares: 0, counts: 0 });
});

test('runtime hosted fallback refuses a local-only policy before prompt preparation', async () => {
  const f = fixture();
  f.modelAdapter.verifyRuntime = () => ({ ...f.modelRuntime, dataHandling: 'hosted' });
  await assert.rejects(() => prepareAdapterHandshake(f.policy, f.bundle, f),
    (error) => error.code === 'DATA_HANDLING_MISMATCH');
  assert.deepEqual(f.calls(), { prepares: 0, counts: 0 });
});

test('handshake refuses missing or nonconservative token bounds', async () => {
  const f = fixture();
  f.modelAdapter.countInputTokens = () => ({ upperBound: 1, conservative: false });
  await assert.rejects(() => prepareAdapterHandshake(f.policy, f.bundle, f),
    (error) => error.code === 'TOKEN_BOUNDS_UNAVAILABLE');
  const g = fixture();
  g.modelAdapter.countInputTokens = () => ({ upperBound: g.policy.budgets.maxInputTokensPerReviewer + 1,
    conservative: true });
  await assert.rejects(() => prepareAdapterHandshake(g.policy, g.bundle, g),
    (error) => error.code === 'BUDGET_EXCEEDED');
});

test('handshake refuses incomplete prompts and hides adapter exceptions', async () => {
  const f = fixture();
  delete f.prompts.security;
  await assert.rejects(() => prepareAdapterHandshake(f.policy, f.bundle, f),
    (error) => error.code === 'INVALID_PROMPT_SET');
  const g = fixture();
  const secret = 'PRIVATE_ADAPTER_FAILURE_VALUE';
  g.modelAdapter.prepareRequest = () => { throw new Error(secret); };
  await assert.rejects(() => prepareAdapterHandshake(g.policy, g.bundle, g),
    (error) => error.code === 'ADAPTER_FAILED' && !error.message.includes(secret));
});
