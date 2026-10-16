import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { preflightPodmanSandbox } from '../src/adapters/sandbox/podman-preflight.js';
import { createStaticReviewHarnessAdapter } from '../src/adapters/harness/static-review.js';
import { preflightFiles } from '../src/core/preflight.js';
import { runPodmanSandbox } from '../src/adapters/sandbox/podman-runner.js';
import { runStaticReview } from '../src/core/static-review.js';

const basePolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));

function setup() {
  const policy = structuredClone(basePolicy);
  policy.dataPolicy.selectedProvider = 'subscription-agent';
  policy.dataPolicy.allowedProviders = ['subscription-agent'];
  policy.dataPolicy.mode = 'approved-hosted';
  policy.budgets.maxInputTokensPerReviewer = 200000;
  const request = { contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/example.js', changeType: 'added', content: 'export const answer = 42;\n' },
  ] } };
  const capabilities = { contractVersion: '1.0', adapterId: 'fake-subscription-agent',
    adapterType: 'model', adapterVersion: '1.0', providerId: 'subscription-agent',
    modelId: 'agent', dataHandling: 'hosted', contextWindowTokens: 300000,
    maxOutputTokens: 2000, limitations: [], controls: {
      freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
      structuredOutput: 'enforced', usageReporting: 'unsupported',
    } };
  const calls = [];
  const modelAdapter = {
    getCapabilities: () => capabilities,
    verifyRuntime: () => capabilities,
    prepareRequest: ({ role, prompt }) => JSON.stringify({ role, prompt }),
    countInputTokens: ({ payload }) => ({ upperBound: Buffer.byteLength(payload), conservative: true }),
    invokeReview: async (args) => {
      calls.push(args);
      const prompt = JSON.parse(JSON.parse(args.payload).prompt);
      return { contractVersion: '1.0', reviewId: prompt.reviewId,
        snapshotSha256: prompt.snapshotSha256, invocationId: args.invocationId,
        contextId: `context-${args.role}`, reviewer: args.role,
        adapter: { adapterId: 'fake-subscription-agent', providerId: 'subscription-agent', modelId: 'agent' },
        promptVersion: prompt.promptVersion, skills: prompt.skills.map((skill) => skill.id),
        status: 'completed', findings: [], verdict: 'recommend-approval' };
    },
  };
  return { policy, request, modelAdapter, calls };
}

test('static review entry point captures once and dispatches isolated agents', async () => {
  const fixture = setup();
  const report = await runStaticReview(fixture);
  assert.equal(report.status, 'complete');
  assert.equal(report.verdict, 'recommend-approval');
  assert.deepEqual(fixture.calls.map((call) => call.role), fixture.policy.reviewers);
  assert.equal(new Set(fixture.calls.map((call) => call.invocationId)).size, 3);
  for (const call of fixture.calls) {
    assert.equal(call.freshContext, true);
    assert.equal(call.memoryEnabled, false);
    assert.deepEqual(call.tools, []);
    assert.equal(call.payload.includes('src/example.js'), false);
  }
});

test('static review entry point rejects unsafe input before an agent call', async () => {
  const fixture = setup();
  fixture.request.input.files[0].path = '../outside.js';
  await assert.rejects(() => runStaticReview(fixture));
  assert.equal(fixture.calls.length, 0);
});

test('static review persists metadata only when audit storage is selected', async (t) => {
  const fixture = setup();
  const directory = await mkdtemp(join(tmpdir(), 'triview-review-audit-'));
  t.after(() => rm(directory, { recursive: true }));
  const report = await runStaticReview({ ...fixture, audit: { directory, retentionDays: 7 } });
  assert.equal(report.status, 'complete');
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const contents = await readFile(join(directory, names[0]), 'utf8');
  assert.equal(contents.includes('src/example.js'), false);
  assert.equal(JSON.parse(contents).event, 'review-finished');
});

const image = `docker.io/library/python@sha256:${'a'.repeat(64)}`;
function sandboxFixture(outcome = { status: 0, stdout: 'sandbox success', stderr: '' }) {
  const fixture = setup();
  fixture.policy.sandbox = { executionRequested: true, backend: 'podman', network: 'disabled' };
  fixture.sandbox = { image, command: ['/usr/local/bin/python', '--version'] };
  fixture.sandboxRuntime = { platform: 'linux', userId: 1000, groupId: 1000,
    runPodman: (args) => args[0] === 'info' ? { status: 0, stdout: JSON.stringify({ host: {
      serviceIsRemote: false, cgroupVersion: 'v2', security: { rootless: true, seccompEnabled: true },
    } }) } : args[0] === 'image' ? { status: 0, stdout: JSON.stringify([{
      Digest: `sha256:${'a'.repeat(64)}`, RepoDigests: [image],
    }]) } : outcome };
  fixture.sandboxAdapter = { runVerification: (args) => runPodmanSandbox({ ...fixture.sandboxRuntime, ...args }) };
  fixture.sandboxAdapter.preflight = ({ policy, image }) => preflightPodmanSandbox({ ...fixture.sandboxRuntime, policy, image });
  return fixture;
}

test('requested sandbox result reaches the report and metadata-only audit', async (t) => {
  const fixture = sandboxFixture();
  const directory = await mkdtemp(join(tmpdir(), 'triview-sandbox-audit-'));
  t.after(() => rm(directory, { recursive: true }));
  const report = await runStaticReview({ ...fixture, audit: { directory, retentionDays: 7 } });
  assert.equal(report.status, 'complete');
  assert.equal(report.sandbox.status, 'completed');
  assert.equal(report.sandbox.stdout, 'sandbox success');
  assert.equal(report.coverage.skippedChecks.some((item) => item.includes('Sandbox verification')), false);
  const contents = await readFile(join(directory, (await readdir(directory))[0]), 'utf8');
  const record = JSON.parse(contents);
  assert.equal(record.sandboxStatus, 'completed');
  assert.equal(record.sandboxImageSha256, 'a'.repeat(64));
  assert.equal(contents.includes('sandbox success'), false);
  assert.equal(contents.includes('/usr/local/bin/python'), false);
});

test('requested skipped or failed verification cannot recommend approval', async () => {
  for (const outcome of [{ status: 1, stdout: '', stderr: 'test failed' },
    { status: null, error: { code: 'ETIMEDOUT' } }]) {
    const report = await runStaticReview(sandboxFixture(outcome));
    assert.equal(report.status, 'incomplete');
    assert.equal(report.verdict, 'incomplete');
    assert.equal(report.sandbox.status, 'failed');
  }
  const fixture = sandboxFixture();
  delete fixture.sandbox;
  const report = await runStaticReview(fixture);
  assert.equal(report.sandbox.status, 'skipped');
  assert.equal(report.verdict, 'incomplete');
});

test('sandbox configuration cannot bypass execution opt-in or inject runtime options', async () => {
  const fixture = setup();
  fixture.sandbox = { image, command: ['/bin/true'] };
  await assert.rejects(() => runStaticReview(fixture), { code: 'INVALID_SANDBOX_CONFIG' });
  fixture.policy.sandbox = { executionRequested: true, backend: 'podman', network: 'disabled' };
  fixture.sandbox.network = 'host';
  await assert.rejects(() => runStaticReview(fixture), { code: 'INVALID_SANDBOX_CONFIG' });
  assert.equal(fixture.calls.length, 0);
});

test('missing Podman supplies guidance and records an incomplete metadata-only audit', async (t) => {
  const fixture = sandboxFixture();
  const commands = [];
  fixture.sandboxRuntime.runPodman = (args) => {
    commands.push(args[0]);
    return { status: null, error: { code: 'ENOENT' } };
  };
  const directory = await mkdtemp(join(tmpdir(), 'triview-missing-podman-'));
  t.after(() => rm(directory, { recursive: true }));
  const report = await runStaticReview({ ...fixture, audit: { directory, retentionDays: 7 } });
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.sandbox.guidance, 'https://podman.io/docs/installation');
  assert.deepEqual(commands, ['info']);
  const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0])));
  assert.equal(record.event, 'review-incomplete');
  assert.equal(record.sandboxStatus, 'skipped');
});

test('sandbox adapter errors and malformed success cannot become an approved report', async () => {
  for (const runVerification of [() => { throw new Error('raw diagnostic'); },
    () => ({ status: 'completed', stdout: 'missing identity' }),
    () => ({ status: 'not-requested' }),
    () => ({ status: 'completed', profile: 'linux-rootless-podman-v1', imageSha256: 'b'.repeat(64),
      snapshotScope: 'included-sanitized-files', exitCode: 0, stdout: '', stderr: '' })]) {
    const report = await runStaticReview({ ...sandboxFixture(), sandboxAdapter: { ...sandboxFixture().sandboxAdapter, runVerification } });
    assert.equal(report.verdict, 'incomplete');
    assert.equal(report.sandbox.status, 'failed');
    assert.equal(JSON.stringify(report).includes('raw diagnostic'), false);
  }
});

test('preflight-only exposes metadata and controls without invocation, execution, or audit persistence', async (t) => {
  const fixture = sandboxFixture();
  const directory = await mkdtemp(join(tmpdir(), 'triview-no-audit-'));
  t.after(() => rm(directory, { recursive: true }));
  fixture.sandboxAdapter.runVerification = () => { throw new Error('must never execute'); };
  const output = await runStaticReview({ ...fixture, preflightOnly: true,
    audit: { directory: join(directory, 'audit'), retentionDays: 7 } });
  assert.equal(output.kind, 'preflight');
  assert.equal(output.status, 'ready');
  assert.equal(output.sandbox.status, 'ready');
  assert.equal(output.hostedSourceDisclosure, true);
  assert.equal(output.reviewers.length, 3);
  assert.ok(output.reviewers.every((item) => item.controls.freshContextPerReviewer === 'enforced'));
  assert.equal(JSON.stringify(output).includes('src/example.js'), false);
  assert.equal(JSON.stringify(output).includes('export const answer'), false);
  assert.equal(fixture.calls.length, 0);
  assert.ok(Object.isFrozen(output));
  await assert.rejects(() => readdir(join(directory, 'audit')), { code: 'ENOENT' });
});

test('preflight appears before any calls and unsupported capabilities return a safe refusal', async () => {
  const fixture = setup();
  let announced = false;
  const invoke = fixture.modelAdapter.invokeReview;
  fixture.modelAdapter.invokeReview = (args) => {
    assert.equal(announced, true);
    return invoke(args);
  };
  const report = await runStaticReview({ ...fixture, onPreflight: (preflight) => {
    assert.equal(fixture.calls.length, 0);
    assert.equal(preflight.status, 'ready');
    announced = true;
  } });
  assert.equal(report.preflight.status, 'ready');
  const broken = setup();
  const active = broken.modelAdapter.getCapabilities();
  broken.modelAdapter.verifyRuntime = () => ({ ...active, controls: {
    ...active.controls, freshContextPerReviewer: 'unsupported' } });
  const refused = await runStaticReview({ ...broken, preflightOnly: true });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(broken.calls.length, 0);
  const invalid = await runStaticReview({ ...setup(), audit: { directory: '/tmp/unused', retentionDays: 3651 }, preflightOnly: true });
  assert.equal(invalid.code, 'INVALID_AUDIT_STORE');
});

test('a host can supply an alternate harness without changing reviewer definitions', async () => {
  const fixture = setup();
  const reference = createStaticReviewHarnessAdapter({ policy: fixture.policy,
    bundle: preflightFiles(fixture.request, fixture.policy) });
  const capabilities = { ...reference.getCapabilities(), adapterId: 'alternate-harness' };
  const report = await runStaticReview({ ...fixture, preflightOnly: true, harnessAdapter: {
    assertScope: reference.assertScope, getCapabilities: () => capabilities, verifyRuntime: () => capabilities,
  } });
  assert.equal(report.status, 'ready');
  assert.equal(report.harness.adapterId, 'alternate-harness');
  assert.equal(fixture.calls.length, 0);
});

test('stalled adapter preflight is bounded and aborts before reviewer invocation', async () => {
  const fixture = setup();
  fixture.policy.budgets.timeoutSeconds = 1;
  let signal;
  fixture.modelAdapter.verifyRuntime = (args) => {
    signal = args.signal;
    return new Promise(() => {});
  };
  const report = await runStaticReview({ ...fixture, preflightOnly: true });
  assert.equal(report.code, 'ADAPTER_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(fixture.calls.length, 0);
});

test('known secret patterns in capability metadata never reach visible preflight', async () => {
  const fixture = setup();
  const capabilities = fixture.modelAdapter.getCapabilities();
  const secret = `ghp_${'A'.repeat(36)}`;
  capabilities.modelId = secret;
  let visible;
  const report = await runStaticReview({ ...fixture, preflightOnly: true,
    onPreflight: (value) => { visible = JSON.stringify(value); } });
  assert.equal(report.code, 'UNSAFE_PREFLIGHT');
  assert.equal(visible.includes(secret), false);
  assert.equal(fixture.calls.length, 0);
});
