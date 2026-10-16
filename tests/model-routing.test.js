import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runStaticReview } from '../src/core/static-review.js';

const basePolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));
const request = { contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'src/example.js', changeType: 'added', content: 'export const value = 1;\n' },
] } };

function adapter({ adapterId, providerId, modelId, dataHandling, calls }) {
  const capabilities = { contractVersion: '1.0', adapterId, adapterType: 'model',
    adapterVersion: '1.0', providerId, modelId, dataHandling,
    contextWindowTokens: 300000, maxOutputTokens: 4000, limitations: [],
    controls: { freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
      structuredOutput: 'enforced', usageReporting: 'unsupported' } };
  return {
    getCapabilities: () => capabilities,
    verifyRuntime: () => capabilities,
    prepareRequest: ({ role, prompt }) => {
      calls.push(role);
      return JSON.stringify({ role, prompt });
    },
    countInputTokens: ({ payload }) => ({ upperBound: Buffer.byteLength(payload), conservative: true }),
    invokeReview: ({ role, invocationId, payload }) => {
      const prompt = JSON.parse(JSON.parse(payload).prompt);
      return { contractVersion: '1.0', reviewId: prompt.reviewId,
        snapshotSha256: prompt.snapshotSha256, invocationId,
        contextId: `context-${adapterId}-${role}`, reviewer: role,
        adapter: { adapterId, providerId, modelId },
        promptVersion: prompt.promptVersion, skills: prompt.skills.map((item) => item.id),
        status: 'completed', findings: [], verdict: 'recommend-approval' };
    },
  };
}

function setup() {
  const policy = structuredClone(basePolicy);
  policy.dataPolicy = { mode: 'approved-hosted', allowedProviders: ['claude', 'local'],
    roleRoutes: {
      'code-quality': { adapterId: 'account-a', providerId: 'claude',
        modelId: 'sonnet', dataHandling: 'hosted' },
      security: { adapterId: 'account-b', providerId: 'claude',
        modelId: 'opus', dataHandling: 'hosted' },
      performance: { adapterId: 'local-model', providerId: 'local',
        modelId: 'gemma', dataHandling: 'local' },
    } };
  policy.budgets.maxInputTokensPerReviewer = 100000;
  const calls = [];
  const modelAdapters = Object.fromEntries(policy.reviewers.map((role) => [role,
    adapter({ ...policy.dataPolicy.roleRoutes[role], calls })]));
  return { policy, modelAdapters, calls };
}

test('one review routes roles to two accounts and a local model with attribution', async () => {
  const fixture = setup();
  const report = await runStaticReview({ request, ...fixture });
  assert.equal(report.status, 'complete');
  assert.deepEqual(fixture.calls, fixture.policy.reviewers);
  assert.deepEqual(report.reviewers.map((item) => item.adapter.adapterId),
    ['account-a', 'account-b', 'local-model']);
  assert.deepEqual(report.reviewers.map((item) => item.adapter.modelId),
    ['sonnet', 'opus', 'gemma']);
});

test('a mismatched or missing route fails before any reviewer sees a prompt', async () => {
  const fixture = setup();
  fixture.policy.dataPolicy.roleRoutes.security.modelId = 'different-model';
  await assert.rejects(() => runStaticReview({ request, ...fixture }),
    (error) => error.code === 'PROVIDER_MISMATCH');
  assert.equal(fixture.calls.length, 0);
  const missing = setup();
  delete missing.modelAdapters.security;
  await assert.rejects(() => runStaticReview({ request, ...missing }),
    (error) => error.code === 'INVALID_ADAPTER_ROUTE');
  assert.equal(missing.calls.length, 0);
});

test('routed audit records model identities without source or account paths', async (t) => {
  const fixture = setup();
  const directory = await mkdtemp(join(tmpdir(), 'triview-routed-audit-'));
  t.after(() => rm(directory, { recursive: true }));
  await runStaticReview({ request, ...fixture, audit: { directory, retentionDays: 1 } });
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const contents = await readFile(join(directory, names[0]), 'utf8');
  const record = JSON.parse(contents);
  assert.deepEqual(record.adapters.filter((item) => item.adapterType === 'model')
    .map((item) => item.modelId), ['sonnet', 'opus', 'gemma']);
  assert.equal(contents.includes('src/example.js'), false);
  assert.equal(contents.includes('export const value'), false);
});
