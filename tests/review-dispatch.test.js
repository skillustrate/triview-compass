import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preflightFiles } from '../src/core/preflight.js';
import { runReview } from '../src/core/review-dispatch.js';

const defaultPolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));

function fixture({ partial = false } = {}) {
  const policy = structuredClone(defaultPolicy);
  policy.dataPolicy.selectedProvider = 'local-1';
  policy.dataPolicy.allowedProviders = ['local-1'];
  policy.budgets.maxInputTokensPerReviewer = 200000;
  if (partial) {
    policy.mode = 'partial';
    policy.reviewers = ['security'];
  }
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/app.js', changeType: 'added', content: 'export const value = 1;\n' },
  ] } }, policy);
  const harness = { contractVersion: '1.0', adapterId: 'harness-1', adapterType: 'harness',
    adapterVersion: '1.0', limitations: [], controls: {
      readOnlyInput: 'enforced', noAgentWrite: 'enforced', noAgentExecution: 'enforced',
      noAgentNetwork: 'enforced', freshContextPerReviewer: 'enforced',
      crossSessionMemoryDisabled: 'enforced',
    } };
  const model = { contractVersion: '1.0', adapterId: 'model-1', adapterType: 'model',
    adapterVersion: '1.0', providerId: 'local-1', modelId: 'model-1',
    dataHandling: 'local', contextWindowTokens: 250000, maxOutputTokens: 2000,
    limitations: [], controls: {
      freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
      structuredOutput: 'unsupported', usageReporting: 'unsupported',
    } };
  const calls = [];
  const harnessAdapter = { getCapabilities: () => harness, verifyRuntime: () => harness };
  const modelAdapter = {
    getCapabilities: () => model,
    verifyRuntime: () => model,
    prepareRequest: ({ role, prompt }) => JSON.stringify({ role, prompt }),
    countInputTokens: ({ payload }) => ({ upperBound: Buffer.byteLength(payload), conservative: true }),
    invokeReview: async (args) => {
      calls.push(args);
      return result(args);
    },
  };
  return { policy, bundle, harnessAdapter, modelAdapter, calls };
}

function result({ role, invocationId, payload }, findings = [], contextId = `context-${role}`) {
  const prompt = JSON.parse(JSON.parse(payload).prompt);
  return { contractVersion: '1.0', reviewId: prompt.reviewId,
    snapshotSha256: prompt.snapshotSha256, invocationId, contextId, reviewer: role,
    adapter: { adapterId: 'model-1', providerId: 'local-1', modelId: 'model-1' },
    promptVersion: prompt.promptVersion, skills: prompt.skills.map((item) => item.id),
    status: 'completed', findings,
    verdict: findings.some((item) => ['Critical', 'Required'].includes(item.severity))
      ? 'request-changes' : 'recommend-approval' };
}

function finding(severity = 'Required', evidence = { path: 'F0001', startLine: 1, endLine: 1 }) {
  return { id: 'issue-1', category: 'correctness', severity,
    title: 'Wrong value', impact: 'The result can be incorrect.', evidence,
    confidence: 0.9, skill: 'core-review' };
}

test('starts isolated roles with exact prepared payloads and retains severity disagreement', async () => {
  const f = fixture();
  f.modelAdapter.invokeReview = async (args) => {
    f.calls.push(args);
    return result(args, args.role === 'performance' ? []
      : [finding(args.role === 'security' ? 'Required' : 'Optional')]);
  };
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'complete');
  assert.equal(report.verdict, 'request-changes');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].evidence.path, 'src/app.js');
  assert.equal(report.findings[0].severity, 'Required');
  assert.equal(report.findings[0].disagreement, true);
  assert.equal(report.findings[0].sourceFindings.length, 2);
  assert.deepEqual(f.calls.map((item) => item.role), f.policy.reviewers);
  assert.equal(new Set(f.calls.map((item) => item.invocationId)).size, 3);
  for (const call of f.calls) {
    assert.equal(call.freshContext, true);
    assert.equal(call.memoryEnabled, false);
    assert.deepEqual(call.tools, []);
    assert.equal(call.payload.includes('src/app.js'), false);
    assert.equal(call.payload.includes('Wrong value'), false);
    assert.equal(call.inputTokenUpperBound, Buffer.byteLength(call.payload));
  }
});

test('unknown file IDs remain visible as unverifiable and prevent a complete verdict', async () => {
  const f = fixture();
  f.modelAdapter.invokeReview = async (args) => result(args,
    args.role === 'security' ? [finding('Required', { path: 'F9999', startLine: 1, endLine: 1 })] : []);
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.verdict, 'incomplete');
  assert.deepEqual(report.unverifiableFindings.map((item) => item.reason), ['unknown-file-id']);
  assert.equal(report.unverifiableFindings[0].title, 'Wrong value');
  assert.equal(report.findings.length, 0);
  assert.equal(report.reviewers.find((item) => item.role === 'security').status, 'failed');
});

test('invalid line anchors do not erase other verified findings', async () => {
  const f = fixture();
  f.modelAdapter.invokeReview = async (args) => result(args,
    args.role === 'security' ? [finding('Required'),
      { ...finding('Optional', { path: 'F0001', startLine: 20, endLine: 21 }), id: 'issue-2' }] : []);
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].evidence.path, 'src/app.js');
  assert.deepEqual(report.unverifiableFindings.map((item) => item.reason), ['invalid-line-range']);
});

test('known secret patterns in reviewer output are withheld from the report', async () => {
  const f = fixture();
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  f.modelAdapter.invokeReview = async (args) => result(args,
    args.role === 'security' ? [{ ...finding('Optional'), title: `Leaked ${secret}` }] : []);
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'incomplete');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.reviewers.find((item) => item.role === 'security').status, 'failed');
});

test('multiline private keys in reviewer fields are withheld', async () => {
  const f = fixture();
  const secret = '-----BEGIN PRIVATE KEY-----\nsynthetic-key-material\n-----END PRIVATE KEY-----';
  f.modelAdapter.invokeReview = async (args) => result(args,
    args.role === 'security' ? [{ ...finding('Optional'), impact: secret }] : []);
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'incomplete');
  assert.equal(JSON.stringify(report).includes('synthetic-key-material'), false);
});

test('shared provider context fails affected reviewers', async () => {
  const f = fixture();
  f.modelAdapter.invokeReview = async (args) => result(args, [], 'shared-context');
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reviewers.filter((item) => item.status === 'failed').length, 3);
});

test('a runtime control change after preparation blocks every invocation', async () => {
  const f = fixture();
  const active = f.modelAdapter.verifyRuntime();
  let checks = 0;
  f.modelAdapter.verifyRuntime = () => {
    checks++;
    return checks === 1 ? active : { ...active,
      controls: { ...active.controls, crossSessionMemoryDisabled: 'unsupported' } };
  };
  await assert.rejects(() => runReview(f.policy, f.bundle, f),
    (error) => error.code === 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('a policy change during payload preparation blocks every invocation', async () => {
  const f = fixture();
  const prepare = f.modelAdapter.prepareRequest;
  f.modelAdapter.prepareRequest = (args) => {
    const payload = prepare(args);
    if (args.role === 'performance') f.policy.budgets.maxOutputTokensPerReviewer = 1500;
    return payload;
  };
  await assert.rejects(() => runReview(f.policy, f.bundle, f),
    (error) => error.code === 'POLICY_CHANGED');
  assert.equal(f.calls.length, 0);
});

test('a malformed result is isolated and an explicit partial review lists omissions', async () => {
  const f = fixture({ partial: true });
  const partial = await runReview(f.policy, f.bundle, f);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.reviewers.filter((item) => item.status === 'omitted').length, 2);
  assert.equal(f.calls.length, 1);
  f.modelAdapter.invokeReview = async () => ({ arbitrary: 'PRIVATE_ADAPTER_FAILURE_VALUE' });
  const incomplete = await runReview(f.policy, f.bundle, f);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(JSON.stringify(incomplete).includes('PRIVATE_ADAPTER_FAILURE_VALUE'), false);
});

test('an asynchronous reviewer timeout makes the review incomplete', async () => {
  const f = fixture({ partial: true });
  f.policy.budgets.timeoutSeconds = 1;
  f.modelAdapter.invokeReview = async () => new Promise(() => {});
  const report = await runReview(f.policy, f.bundle, f);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reviewers.find((item) => item.role === 'security').status, 'failed');
  assert.match(report.limitations.join(' '), /time limit/u);
});
