import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareAdapterHandshake } from '../src/core/adapter-handshake.js';
import { freezeBundle, preflightFiles } from '../src/core/preflight.js';
import { buildReviewerPrompts } from '../src/core/prompt-builder.js';
import { prepareReviewInputs } from '../src/core/prepare-review.js';

const basePolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));

function fixture() {
  const policy = structuredClone(basePolicy);
  const pathSecret = 'AKIAABCDEFGHIJKLMNOP';
  const contentSecret = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: `src/${pathSecret}.js`, changeType: 'added', content: `const token = '${contentSecret}';\n` },
    { path: '.env', changeType: 'added', content: 'PRIVATE_EXCLUDED_VALUE\n' },
    { path: 'dist/generated.js', changeType: 'added', content: 'PRIVATE_GENERATED_VALUE\n' },
  ] } }, policy);
  return { policy, bundle, pathSecret, contentSecret };
}

function fakeAdapters() {
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
  return {
    harnessAdapter: { getCapabilities: () => harness, verifyRuntime: () => harness },
    modelAdapter: {
      getCapabilities: () => model,
      verifyRuntime: () => model,
      prepareRequest: ({ role, prompt }) => JSON.stringify({ role, prompt }),
      countInputTokens: ({ payload }) => ({ upperBound: Buffer.byteLength(payload), conservative: true }),
    },
  };
}

test('builder includes every required role skill and no real file paths', () => {
  const { policy, bundle, pathSecret, contentSecret } = fixture();
  const built = buildReviewerPrompts(bundle, policy);
  const expected = {
    'code-quality': ['core-review'],
    security: ['core-review', 'security-review', 'adversarial-input-review'],
    performance: ['core-review', 'performance-review'],
  };
  for (const role of policy.reviewers) {
    const prompt = built.prompts[role];
    const document = JSON.parse(prompt);
    assert.deepEqual(document.skills.map((skill) => skill.id), expected[role]);
    assert.equal(document.skills.every((skill) => skill.instructions.length > 0), true);
    assert.equal(Buffer.byteLength(prompt, 'utf8') < 12000, true);
    assert.deepEqual(document.files.map((file) => file.path), ['F0001']);
    assert.equal(document.files[0].content.includes(contentSecret), false);
    assert.equal(document.scopeCounts.excluded, 1);
    assert.equal(document.scopeCounts.generated, 1);
    for (const value of [pathSecret, 'PRIVATE_EXCLUDED_VALUE', 'PRIVATE_GENERATED_VALUE']) {
      assert.equal(prompt.includes(value), false);
    }
    for (const path of ['.env', 'dist/generated.js']) {
      assert.equal(JSON.stringify(document.files).includes(path), false);
    }
  }
  assert.equal(built.resolveFileId('F0001').path, `src/${pathSecret}.js`);
  assert.equal(built.resolveFileId('F9999'), undefined);
  assert.equal(JSON.stringify(built).includes(pathSecret), false);
  assert.deepEqual(buildReviewerPrompts(bundle, policy).prompts, built.prompts);
});

test('builder refuses tampered content and a bundle with no reviewable files', () => {
  const { policy, bundle } = fixture();
  const tampered = structuredClone(bundle);
  tampered.files.find((file) => file.state === 'included').content = 'different';
  assert.throws(() => buildReviewerPrompts(freezeBundle(tampered), policy),
    (error) => error.code === 'INVALID_BUNDLE');
  const excluded = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: '.env', changeType: 'added', content: 'hidden' },
  ] } }, policy);
  assert.throws(() => buildReviewerPrompts(excluded, policy),
    (error) => error.code === 'NO_REVIEWABLE_CONTENT');
});

test('numbered source preserves empty and final lines without duplicating raw text or inventing change context', () => {
  const policy = structuredClone(basePolicy);
  const contents = ['first\n\nthird\n', 'first\nlast', '', '\n'];
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files',
    files: contents.map((content, index) => ({ path: `f${index}.js`, changeType: 'modified', content })) } }, policy);
  const prompt = JSON.parse(buildReviewerPrompts(bundle, policy).prompts['code-quality']);
  assert.equal(prompt.format, 'triview-compass-prompt-v2');
  assert.deepEqual(prompt.files.map((file) => file.content), ['1 | first\n2 | \n3 | third', '1 | first\n2 | last', '', '1 | ']);
  assert.deepEqual(prompt.files.map((file) => file.lineCount), [3, 2, 0, 1]);
  assert.ok(prompt.files.every((file) => file.contentFormat === 'numbered-lines'
    && file.changeContext.status === 'unavailable' && file.changeContext.hunks.length === 0));
  assert.ok(prompt.evidenceInstruction.includes('in-range number alone is insufficient'));
});

test('handshake counts the complete generated prompts and rejects insufficient budget', async () => {
  const { policy, bundle } = fixture();
  policy.dataPolicy.selectedProvider = 'local-1';
  policy.dataPolicy.allowedProviders = ['local-1'];
  const built = buildReviewerPrompts(bundle, policy);
  const adapters = fakeAdapters();
  policy.budgets.maxInputTokensPerReviewer = 100;
  await assert.rejects(() => prepareAdapterHandshake(policy, bundle,
    { ...adapters, prompts: built.prompts }), (error) => error.code === 'BUDGET_EXCEEDED');
  policy.budgets.maxInputTokensPerReviewer = 200000;
  const plan = await prepareAdapterHandshake(policy, bundle, { ...adapters, prompts: built.prompts });
  assert.equal(plan.requests.length, 3);
  for (const request of plan.requests) {
    const prepared = JSON.parse(request.payload);
    assert.equal(prepared.prompt, built.prompts[request.role]);
    assert.equal(plan.readiness.inputTokenBounds[request.role], Buffer.byteLength(request.payload));
  }
});

test('supported entry point binds prompts, request payloads, and local ID resolution', async () => {
  const { policy, bundle, pathSecret } = fixture();
  policy.dataPolicy.selectedProvider = 'local-1';
  policy.dataPolicy.allowedProviders = ['local-1'];
  policy.budgets.maxInputTokensPerReviewer = 200000;
  const plan = await prepareReviewInputs(policy, bundle, fakeAdapters());
  assert.equal(plan.requests.length, policy.reviewers.length);
  assert.equal(plan.promptVersions.length, policy.reviewers.length);
  assert.equal(plan.resolveFileId('F0001').path, `src/${pathSecret}.js`);
  for (const request of plan.requests) {
    const prompt = JSON.parse(JSON.parse(request.payload).prompt);
    assert.equal(prompt.snapshotSha256, plan.snapshotSha256);
    assert.equal(prompt.promptVersion, plan.promptVersions.find((item) => item.role === request.role).version);
  }
  assert.equal(JSON.stringify(plan).includes(pathSecret), false);
});
