import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli/review.js';
import { createHostReviewPlan, describeHostHarnesses, runHostReview } from '../src/integrations/host-review.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'triview-host-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = join(directory, 'diagnostic.mjs');
  const log = join(directory, 'calls.jsonl');
  await writeFile(modulePath, `
    import { appendFileSync } from 'node:fs';
    export function createDiagnostic(config) {
      const record = value => appendFileSync(config.log, JSON.stringify(value) + '\\n');
      record({ event: 'factory', id: config.adapterId });
      const capabilities = { contractVersion: '1.0', adapterId: config.adapterId,
        adapterType: 'model', adapterVersion: '1.0', providerId: config.providerId,
        modelId: config.modelId, dataHandling: 'local', contextWindowTokens: 200000,
        maxOutputTokens: 4000, limitations: [], controls: {
          freshContextPerReviewer: config.noIsolation ? 'unsupported' : 'enforced',
          crossSessionMemoryDisabled: 'enforced', structuredOutput: 'enforced', usageReporting: 'unsupported' } };
      return { getCapabilities: () => capabilities, verifyRuntime: () => capabilities,
        prepareRequest: ({ prompt }) => prompt,
        countInputTokens: ({ payload }) => ({ upperBound: Buffer.byteLength(payload), conservative: true }),
        invokeReview: args => {
          record({ event: 'invoke', id: config.adapterId, role: args.role, invocationId: args.invocationId,
            freshContext: args.freshContext, memoryEnabled: args.memoryEnabled, tools: args.tools });
          if (config.fail) throw new Error('provider diagnostic must stay private');
          const prompt = JSON.parse(args.payload);
          return { contractVersion: '1.0', reviewId: prompt.reviewId, snapshotSha256: prompt.snapshotSha256,
            invocationId: args.invocationId, contextId: config.reuseContext ? 'shared' : args.invocationId,
            reviewer: args.role, adapter: { adapterId: config.adapterId, providerId: config.providerId, modelId: config.modelId },
            promptVersion: prompt.promptVersion, skills: prompt.skills.map(item => item.id),
            status: 'completed', findings: [], verdict: 'recommend-approval' };
        } };
    }
  `);
  const harness = id => ({ adapterId: id, providerId: `provider-${id}`, modelId: `model-${id}`, dataHandling: 'local',
    runtime: { kind: 'adapter-module', module: modulePath, export: 'createDiagnostic',
      config: { adapterId: id, providerId: `provider-${id}`, modelId: `model-${id}`, log, privateSetting: 'not-for-choice-ui' } } });
  const context = { contractVersion: '1.0', currentHarness: 'present',
    harnesses: { present: harness('present'), alternate: harness('alternate') } };
  const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));
  policy.dataPolicy = { mode: 'local-only', allowedProviders: ['provider-present', 'provider-alternate'] };
  const request = { contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/sample.js', changeType: 'added', content: 'export const value = 42;\n' },
  ] } };
  const events = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  await writeFile(join(directory, 'context.json'), JSON.stringify(context));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), JSON.stringify(request));
  return { context, policy, request, directory, events };
}

test('host asks before loading adapters; no alternatives starts three fresh current-harness sessions', async t => {
  const f = await fixture(t);
  let asked = 0;
  const report = await runHostReview({ ...f, chooseHarnesses: async description => {
    asked++;
    assert.deepEqual(await f.events(), []);
    assert.equal(description.currentHarness, 'present');
    assert.equal(JSON.stringify(description).includes('not-for-choice-ui'), false);
    assert.equal(Object.isFrozen(description.harnesses), true);
    return { harnesses: [] };
  } });
  assert.equal(asked, 1);
  assert.equal(report.status, 'complete');
  const calls = (await f.events()).filter(e => e.event === 'invoke');
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(c => c.invocationId)).size, 3);
  assert.equal(new Set(report.reviewers.map(r => r.contextId)).size, 3);
  assert.ok(calls.every(c => c.id === 'present' && c.freshContext && !c.memoryEnabled && c.tools.length === 0));
});

test('one explicitly chosen alternative handles all roles and never starts the current harness', async t => {
  const f = await fixture(t);
  const report = await runHostReview({ ...f, selection: { harnesses: ['alternate'] },
    chooseHarnesses: () => { throw new Error('saved selection must not prompt'); } });
  assert.equal(report.status, 'complete');
  assert.ok((await f.events()).every(e => e.id === 'alternate'));
  assert.ok(report.reviewers.every(r => r.adapter.adapterId === 'alternate'));
});

test('multiple selected harnesses require and obey explicit role assignments', async t => {
  const f = await fixture(t);
  const selection = { harnesses: ['present', 'alternate'], assignments: {
    'code-quality': 'present', security: 'alternate', performance: 'present',
  } };
  const original = structuredClone(f.policy);
  const report = await runHostReview({ ...f, selection });
  assert.deepEqual(report.reviewers.map(r => r.adapter.adapterId), ['present', 'alternate', 'present']);
  assert.deepEqual(f.policy, original);
  assert.equal(report.status, 'complete');
});

test('invalid, ambiguous, cancelled, or unavailable selections stop before loading any adapter', async t => {
  const f = await fixture(t);
  for (const selection of [undefined, null, {}, { harnesses: ['missing'] },
    { harnesses: ['present', 'present'] }, { harnesses: ['present', 'alternate'] },
    { harnesses: [], assignments: { security: 'present' } },
    { harnesses: [], assignments: { 'code-quality': 'alternate', security: 'present', performance: 'present' } },
    { harnesses: ['present', 'alternate'], assignments: { 'code-quality': 'present', security: 'present', performance: 'present' } },
  ]) {
    await assert.rejects(runHostReview({ ...f, selection }), { code: 'INVALID_HARNESS_SELECTION' });
  }
  await assert.rejects(runHostReview({ ...f, chooseHarnesses: async () => null }), { code: 'INVALID_HARNESS_SELECTION' });
  f.context.currentHarness = 'missing';
  assert.equal(describeHostHarnesses(f.context).currentAvailable, false);
  assert.throws(() => createHostReviewPlan(f.context, { harnesses: [] }, f.policy), { code: 'CURRENT_HARNESS_UNAVAILABLE' });
  assert.equal(createHostReviewPlan(f.context, { harnesses: ['alternate'] }, f.policy).assignments.security, 'alternate');
  f.context.currentHarness = `ghp_${'A'.repeat(36)}`;
  assert.throws(() => describeHostHarnesses(f.context), { code: 'UNSAFE_HOST_CONTEXT' });
  f.context.currentHarness = 'present';
  f.context.harnesses.present.runtime.module = './reviewed-repo-adapter.mjs';
  assert.throws(() => describeHostHarnesses(f.context), { code: 'INVALID_HOST_CONTEXT' });
  assert.deepEqual(await f.events(), []);
});

test('host selection never expands provider, data, model-call, or reviewer-budget permissions', async t => {
  const f = await fixture(t);
  f.policy.dataPolicy.allowedProviders = ['provider-alternate'];
  assert.throws(() => createHostReviewPlan(f.context, { harnesses: [] }, f.policy), { code: 'PROVIDER_NOT_ALLOWED' });
  f.policy.dataPolicy.allowedProviders.push('provider-present');
  f.context.harnesses.present.dataHandling = 'hosted';
  assert.throws(() => createHostReviewPlan(f.context, { harnesses: [] }, f.policy), { code: 'DATA_HANDLING_MISMATCH' });
  f.context.harnesses.present.dataHandling = 'local';
  f.policy.dataPolicy = { mode: 'disallow-model-calls', allowedProviders: [] };
  assert.throws(() => createHostReviewPlan(f.context, { harnesses: [] }, f.policy), { code: 'MODEL_CALLS_DISABLED' });
  assert.deepEqual(await f.events(), []);
});

test('current-harness identity and isolation must match the adapter, with no fallback on failure', async t => {
  const f = await fixture(t);
  f.context.harnesses.present.runtime.config.modelId = 'wrong';
  await assert.rejects(runHostReview({ ...f, selection: { harnesses: [] } }), { code: 'PROVIDER_MISMATCH' });
  assert.equal((await f.events()).some(e => e.event === 'invoke'), false);
  f.context.harnesses.present.runtime.config.modelId = 'model-present';
  f.context.harnesses.present.runtime.config.noIsolation = true;
  await assert.rejects(runHostReview({ ...f, selection: { harnesses: [] } }), { code: 'CAPABILITY_UNAVAILABLE' });
  f.context.harnesses.present.runtime.config.noIsolation = false;
  f.context.harnesses.present.runtime.config.fail = true;
  const failed = await runHostReview({ ...f, selection: { harnesses: [] } });
  assert.equal(failed.status, 'incomplete');
  assert.equal(JSON.stringify(failed).includes('provider diagnostic'), false);
  assert.ok((await f.events()).every(e => e.id === 'present'));
  f.context.harnesses.present.runtime.config.fail = false;
  f.context.harnesses.present.runtime.config.reuseContext = true;
  const shared = await runHostReview({ ...f, selection: { harnesses: [] } });
  assert.equal(shared.status, 'incomplete');
  assert.ok(shared.reviewers.every(r => r.reason === 'Reviewers shared a provider context.'));
});

test('explicit partial reviews and token limits remain effective with the current harness', async t => {
  const f = await fixture(t);
  f.policy.mode = 'partial';
  f.policy.reviewers = ['code-quality', 'security'];
  f.policy.budgets.maxModelCalls = 2;
  const report = await runHostReview({ ...f, selection: { harnesses: [] } });
  assert.equal(report.status, 'partial');
  assert.equal(report.reviewers.find(r => r.role === 'performance').status, 'omitted');
  assert.equal((await f.events()).filter(e => e.event === 'invoke').length, 2);
  f.policy.budgets.maxInputTokensPerReviewer = 1;
  const refused = await runHostReview({ ...f, selection: { harnesses: [] }, preflightOnly: true });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.code, 'BUDGET_EXCEEDED');
  assert.equal((await f.events()).filter(e => e.event === 'invoke').length, 2);
});

test('CLI asks for current or alternative harnesses; blank/none dispatches current only', async t => {
  const f = await fixture(t);
  const base = ['--request', join(f.directory, 'request.json'), '--policy', join(f.directory, 'policy.json'),
    '--host-context', join(f.directory, 'context.json')];
  for (const answer of ['\n', 'none\n', 'alternate\n', 'unknown\nnone\n']) {
    let text = '';
    let output = '';
    let selected;
    await main(base, { env: {}, interactive: true, stdin: Readable.from([answer]),
      stdout: { write: s => { output += s; } }, stderr: { write: s => { text += s; } },
      runReview: async args => { selected = args; return { status: 'complete' }; } });
    assert.match(text, /Which review harnesses/u);
    assert.equal(text.includes('not-for-choice-ui'), false);
    assert.equal(JSON.parse(output).status, 'complete');
    const id = answer === 'alternate\n' ? 'alternate' : 'present';
    assert.ok(Object.values(selected.policy.dataPolicy.roleRoutes).every(route => route.adapterId === id));
  }
  let captured;
  await main(base, { env: {}, interactive: true,
    stdin: Readable.from(['present,alternate\npresent\nalternate\npresent\n']),
    stdout: { write() {} }, stderr: { write() {} },
    runReview: async args => { captured = args; return { status: 'complete' }; } });
  assert.equal(captured.policy.dataPolicy.roleRoutes.security.adapterId, 'alternate');
  for (const answer of ['', 'cancel\n', 'present,alternate\npresent\n']) {
    await assert.rejects(main(base, { env: {}, interactive: true, stdin: Readable.from([answer]),
      stdout: { write() {} }, stderr: { write() {} } }), /cancelled/u);
  }
});

test('noninteractive host receives an explicit chat choice; direct runtime overrides ambient host context', async t => {
  const f = await fixture(t);
  const base = ['--request', join(f.directory, 'request.json'), '--policy', join(f.directory, 'policy.json')];
  const env = { CI: 'true', TRIVIEW_HOST_CONTEXT: join(f.directory, 'context.json') };
  await assert.rejects(main(base, { env }), /host must ask/u);
  let output = '';
  await main([...base, '--review-harnesses', 'none'], { env,
    stdout: { write: s => { output += s; } }, stderr: { write() {} } });
  assert.equal(JSON.parse(output).status, 'complete');
  const assignments = join(f.directory, 'assignments.json');
  await writeFile(assignments, JSON.stringify({ 'code-quality': 'present', security: 'alternate', performance: 'present' }));
  let captured;
  await main([...base, '--review-harnesses', 'present,alternate', '--review-assignments', assignments], { env,
    stdout: { write() {} }, stderr: { write() {} }, runReview: async args => { captured = args; return { status: 'complete' }; } });
  assert.equal(captured.policy.dataPolicy.roleRoutes.security.adapterId, 'alternate');
  const runtime = f.context.harnesses.alternate.runtime;
  const configPath = join(f.directory, 'alternate.json');
  await writeFile(configPath, JSON.stringify(runtime.config));
  await main([...base, '--adapter-module', runtime.module, '--adapter-export', runtime.export, '--adapter-config', configPath], {
    env: { TRIVIEW_HOST_CONTEXT: '/missing/context.json' }, interactive: false,
    stdout: { write() {} }, stderr: { write() {} }, runReview: async args => {
      assert.equal(args.modelAdapter.getCapabilities().adapterId, 'alternate');
      return { status: 'complete' };
    } });
  await assert.rejects(main([...base, '--host-context', join(f.directory, 'context.json'),
    '--adapter-module', runtime.module, '--adapter-export', runtime.export], { env }), /cannot be combined/u);
});
