#!/usr/bin/env node
// Real Podman execution with a diagnostic model adapter: no provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPodmanSandboxAdapter } from '../../src/adapters/sandbox/podman-runner.js';
import { main } from '../../src/cli/review.js';
import { runStaticReview } from '../../src/core/static-review.js';

const image = process.argv[2];
if (!image) throw new Error('Pass an already-local, digest-pinned Python image reference.');
const policy = JSON.parse(await readFile(new URL('../../examples/claude-code-policy.json', import.meta.url)));
policy.sandbox = { executionRequested: true, backend: 'podman', network: 'disabled' };
policy.budgets.maxLinesPerFile = 2000;
policy.budgets.maxChangedLines = 3000;
const schema = await readFile(new URL('../../contracts/schemas/consolidated-report.schema.json', import.meta.url), 'utf8');
const request = { contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'schema.json', changeType: 'modified', content: schema },
  { path: 'check.py', changeType: 'added', content: "import json\nwith open('/src/schema.json') as f: assert 'sandbox' in json.load(f)['properties']\nprint('schema check passed')\n" },
  { path: 'timeout.py', changeType: 'added', content: 'import time\ntime.sleep(5)\n' },
  { path: 'output.py', changeType: 'added', content: "print('ghp_' + 'A' * 36)\n" },
] } };
const capabilities = { contractVersion: '1.0', adapterId: 'diagnostic-model', adapterType: 'model',
  adapterVersion: '1.0', providerId: 'anthropic-claude-code', modelId: 'diagnostic',
  dataHandling: 'hosted', contextWindowTokens: 300000, maxOutputTokens: 2000,
  limitations: ['Diagnostic model adapter; no provider calls.'], controls: {
    freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
    structuredOutput: 'enforced', usageReporting: 'unsupported',
  } };
const adapter = { getCapabilities: () => capabilities, verifyRuntime: () => capabilities,
  prepareRequest: ({ role, prompt }) => JSON.stringify({ role, prompt }),
  countInputTokens: ({ payload }) => ({ conservative: true, upperBound: Buffer.byteLength(payload) }),
  invokeReview: (args) => {
    const prompt = JSON.parse(JSON.parse(args.payload).prompt);
    return { contractVersion: '1.0', reviewId: prompt.reviewId, snapshotSha256: prompt.snapshotSha256,
      invocationId: args.invocationId, contextId: `diagnostic-${args.role}`, reviewer: args.role,
      adapter: { adapterId: capabilities.adapterId, providerId: capabilities.providerId, modelId: capabilities.modelId },
      promptVersion: prompt.promptVersion, skills: prompt.skills.map((item) => item.id),
      status: 'completed', findings: [], verdict: 'recommend-approval' };
  } };
const directory = await mkdtemp(join(tmpdir(), 'triview-workflow-probe-'));
try {
  const config = { image, command: ['/usr/local/bin/python', '/src/check.py'] };
  await writeFile(join(directory, 'request.json'), JSON.stringify(request));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'sandbox.json'), JSON.stringify(config));
  let reportJson = '';
  let disclosure = '';
  await main(['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json'),
    '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000', '--sandbox-config', join(directory, 'sandbox.json'),
    '--audit-dir', join(directory, 'audit'), '--retention-days', '7'], {
    runReview: (args) => runStaticReview({ ...args, modelAdapter: adapter }),
    stdout: { write: (value) => { reportJson += value; } },
    stderr: { write: (value) => { disclosure += value; } },
  });
  const report = JSON.parse(reportJson);
  assert.equal(report.status, 'complete');
  assert.equal(report.sandbox.stdout.trim(), 'schema check passed');
  assert.ok(disclosure.includes(image));
  const audit = JSON.parse(await readFile(join(directory, 'audit', (await readdir(join(directory, 'audit')))[0])));
  assert.equal(audit.sandboxStatus, 'completed');
  assert.equal(JSON.stringify(audit).includes('schema check passed'), false);
  const timed = await runStaticReview({ request, sandboxAdapter: createPodmanSandboxAdapter(), policy: { ...policy, budgets: { ...policy.budgets, timeoutSeconds: 1 } },
    modelAdapter: adapter, sandbox: { image, command: ['/usr/local/bin/python', '/src/timeout.py'] } });
  assert.equal(timed.verdict, 'incomplete');
  assert.equal(timed.sandbox.status, 'failed');
  const output = await runStaticReview({ request, policy, sandboxAdapter: createPodmanSandboxAdapter(), modelAdapter: adapter,
    sandbox: { image, command: ['/usr/local/bin/python', '/src/output.py'] } });
  assert.match(output.sandbox.stdout, /\[REDACTED: credential\]/u);
  const missing = await runStaticReview({ request, policy, sandboxAdapter: createPodmanSandboxAdapter(), modelAdapter: adapter,
    sandbox: { image: `docker.io/library/python@sha256:${'b'.repeat(64)}`, command: ['/bin/true'] } });
  assert.equal(missing.sandbox.status, 'skipped');
  assert.equal(missing.verdict, 'incomplete');
  process.stdout.write('Sandbox workflow probe passed: CLI/report/audit, captured schema, timeout, scanned output, and missing image. No provider calls.\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
