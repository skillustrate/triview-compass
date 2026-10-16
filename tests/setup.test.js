import assert from 'node:assert/strict';
import { chmod, readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { runSetup } from '../src/cli/setup.js';

function io(lines) {
  const input = Readable.from([`${lines.join('\n')}\n`]);
  let written = '';
  const output = new Writable({ write(chunk, _enc, callback) { written += chunk; callback(); } });
  return { input, output, transcript: () => written };
}

function fakeAdapter(capabilities) {
  return { getCapabilities: () => capabilities, verifyRuntime: () => capabilities,
    prepareRequest: () => '{}', countInputTokens: () => ({ upperBound: 1, conservative: true }),
    invokeReview: async () => ({ status: 'completed' }) };
}

test('declining a detected harness lets the user choose a different adapter before loading anything', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-choice-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output, transcript } = io([
    'yes', 'no', 'no', // security only
    'no', 'no', // local only; one harness
    'yes', 'no', // detect candidate; decline it
    'no', 'chosen.mjs', 'createChosen', '', // configure another adapter
    'no', 'no', 'yes', // no sandbox/audit; save
  ]);
  const calls = [];
  const result = await runSetup({ input, output, outputDir, env: {},
    detect: async () => ({ kind: 'adapter-module', module: 'unselected.mjs', export: 'createUnselected' }),
    loadAdapter: async (modulePath) => {
      calls.push(modulePath);
      return fakeAdapter({ providerId: 'chosen', modelId: 'chosen-model', dataHandling: 'local' });
    } });
  assert.equal(result.written, true);
  assert.deepEqual(calls, ['chosen.mjs'], 'declined candidate must never be imported');
  assert.match(transcript(), /Do you want to load and use this harness/u);
  assert.equal(result.command[result.command.indexOf('--adapter-module') + 1], 'chosen.mjs');
});

test('single Claude Code harness is used only after confirming the detected candidate', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'yes', 'yes', 'yes', 'no', 'no', 'yes', 'yes', 'no', 'no', 'yes']);
  const detect = async () => ({ kind: 'claude-code', modelId: 'sonnet' });
  const result = await runSetup({ input, output, outputDir, env: {}, detect,
    loadAdapter: async () => { throw new Error('must not be called for a detected Claude Code assistant'); } });
  assert.equal(result.written, true);
  const policy = JSON.parse(await readFile(result.policyPath, 'utf8'));
  assert.equal(policy.mode, 'full');
  assert.deepEqual(policy.reviewers, ['code-quality', 'security', 'performance']);
  assert.deepEqual(policy.dataPolicy, { mode: 'approved-hosted',
    allowedProviders: ['anthropic-claude-code'], selectedProvider: 'anthropic-claude-code' });
  assert.equal(result.routesPath, undefined);
  assert.deepEqual(result.command, ['node', 'src/cli/review.js', '--request', '<your-request.json>',
    '--policy', result.policyPath, '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000']);
});

test('local-only review with a manually configured generic adapter', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'no', 'no', 'no', 'no', 'no', 'no', 'fake/module.js', 'createFakeAdapter',
    'key1 = value1', '', 'no', 'no', 'yes']);
  const calls = [];
  const loadAdapter = async (modulePath, exportName, config) => {
    calls.push({ modulePath, exportName, config });
    return fakeAdapter({ providerId: 'local-provider', modelId: 'local-model', dataHandling: 'local' });
  };
  const result = await runSetup({ input, output, outputDir, env: {}, loadAdapter });
  assert.equal(result.written, true);
  assert.deepEqual(calls, [{ modulePath: 'fake/module.js', exportName: 'createFakeAdapter', config: { key1: 'value1' } }]);
  const policy = JSON.parse(await readFile(result.policyPath, 'utf8'));
  assert.equal(policy.mode, 'partial');
  assert.deepEqual(policy.reviewers, ['security']);
  assert.deepEqual(policy.dataPolicy, { mode: 'local-only',
    allowedProviders: ['local-provider'], selectedProvider: 'local-provider' });
  assert.deepEqual(result.command, ['node', 'src/cli/review.js', '--request', '<your-request.json>',
    '--policy', result.policyPath, '--adapter-module', 'fake/module.js', '--adapter-export', 'createFakeAdapter',
    '--adapter-config', result.adapterConfigPath]);
  assert.deepEqual(JSON.parse(await readFile(result.adapterConfigPath, 'utf8')), { key1: 'value1' });
});

test('disallow-model-calls still gathers a runtime so the printed command runs, but writes no provider fields', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'no', 'no', 'yes', 'yes', 'no', 'yes', 'yes', 'no', 'no', 'yes']);
  const detect = async () => ({ kind: 'claude-code', modelId: 'opus' });
  const result = await runSetup({ input, output, outputDir, env: {}, detect });
  assert.equal(result.written, true);
  const policy = JSON.parse(await readFile(result.policyPath, 'utf8'));
  assert.deepEqual(policy.dataPolicy, { mode: 'disallow-model-calls', allowedProviders: [] });
  assert.deepEqual(result.command, ['node', 'src/cli/review.js', '--request', '<your-request.json>',
    '--policy', result.policyPath, '--harness', 'claude-code', '--model', 'opus', '--context-window', '200000']);
});

test('mixing a detected Claude Code assistant with a manually configured one across roles writes routes.json', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io([
    'yes', 'yes', 'no', // security, performance; no code-quality -> ['security','performance']
    'yes', 'no', // approved-hosted, don't skip model calls
    'yes', // multiple assistants
    // security: gather
    'no', 'no', 'other/adapter.js', 'createOther', '', // not running, no settings file, no config lines
    // performance: don't reuse, gather a different one
    'no', 'yes', 'yes', // reuse? no; detect? yes; choose detected harness? yes
    'no', 'no', // sandbox, audit
    'yes', // confirm
  ]);
  const detect = async () => ({ kind: 'claude-code', modelId: 'haiku' });
  const loadAdapter = async () => fakeAdapter({ providerId: 'other-provider', modelId: 'other-model', dataHandling: 'hosted' });
  const result = await runSetup({ input, output, outputDir, env: {}, detect, loadAdapter });
  assert.equal(result.written, true);
  const routes = JSON.parse(await readFile(result.routesPath, 'utf8'));
  assert.deepEqual(routes.security, { kind: 'adapter-module', module: 'other/adapter.js', export: 'createOther', config: {} });
  assert.deepEqual(routes.performance, { kind: 'claude-code', adapterId: 'claude-default', modelId: 'haiku', contextWindowTokens: 200000 });
  const policy = JSON.parse(await readFile(result.policyPath, 'utf8'));
  assert.deepEqual(new Set(policy.dataPolicy.allowedProviders), new Set(['other-provider', 'anthropic-claude-code']));
  assert.equal(policy.dataPolicy.selectedProvider, undefined);
  assert.ok(policy.dataPolicy.roleRoutes.security);
  assert.ok(policy.dataPolicy.roleRoutes.performance);
  assert.ok(result.command.includes('--routes'));
});

test('declining the final confirmation writes nothing', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'no', 'no', 'no', 'no', 'no', 'no', 'fake/module.js', 'createFakeAdapter', '', 'no', 'no', 'no']);
  const loadAdapter = async () => fakeAdapter({ providerId: 'local-provider', modelId: 'local-model', dataHandling: 'local' });
  const result = await runSetup({ input, output, outputDir, env: {}, loadAdapter });
  assert.equal(result.written, false);
  await assert.rejects(readFile(join(outputDir, 'policy.json'), 'utf8'));
});

test('all reviews declined is rejected and the three questions repeat', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io([
    'no', 'no', 'no', // first pass: none selected, rejected
    'no', 'no', 'yes', // second pass: code-quality only
    'no', // canSendToServers -> local-only
    'no', // multipleAssistants
    'no', 'no', 'fake/module.js', 'createFakeAdapter', '', // gather: not running, no settings file, module, export, no config
    'no', 'no', // sandbox, audit
    'yes', // confirm
  ]);
  const loadAdapter = async () => fakeAdapter({ providerId: 'local-provider', modelId: 'local-model', dataHandling: 'local' });
  const result = await runSetup({ input, output, outputDir, env: {}, loadAdapter });
  assert.equal(result.written, true);
  const policy = JSON.parse(await readFile(result.policyPath, 'utf8'));
  assert.deepEqual(policy.reviewers, ['code-quality']);
});

test('written config files and their directory have owner-only permissions, since they may hold credentials', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'no', 'no', 'no', 'no', 'no', 'no', 'fake/module.js', 'createFakeAdapter',
    'key1 = value1', '', 'no', 'no', 'yes']);
  const loadAdapter = async () => fakeAdapter({ providerId: 'local-provider', modelId: 'local-model', dataHandling: 'local' });
  const result = await runSetup({ input, output, outputDir, env: {}, loadAdapter });
  assert.equal(result.written, true);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.policyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.adapterConfigPath)).mode & 0o777, 0o600);
});

test('re-running into a pre-existing, more permissive directory still tightens its permissions', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  // Simulate an earlier, less restrictive run (or a directory this process
  // didn't create) before the wizard runs again -- writeFile's/mkdir's own
  // `mode` option only takes effect on creation, so without an explicit
  // chmod afterward, re-running into this directory would silently leave
  // these at their old, more permissive mode.
  await chmod(outputDir, 0o755);
  await writeFile(join(outputDir, 'policy.json'), '{}', { mode: 0o644 });
  await chmod(join(outputDir, 'policy.json'), 0o644);
  const { input, output } = io(['yes', 'no', 'no', 'no', 'no', 'no', 'no', 'fake/module.js', 'createFakeAdapter',
    'key1 = value1', '', 'no', 'no', 'yes']);
  const loadAdapter = async () => fakeAdapter({ providerId: 'local-provider', modelId: 'local-model', dataHandling: 'local' });
  const result = await runSetup({ input, output, outputDir, env: {}, loadAdapter });
  assert.equal(result.written, true);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.policyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.adapterConfigPath)).mode & 0o777, 0o600);
});

test('a local-only answer combined with a detected hosted assistant is rejected before writing anything', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'no', 'no', 'no', 'no', 'yes', 'yes', 'no', 'no']);
  const detect = async () => ({ kind: 'claude-code', modelId: 'sonnet' });
  const result = await runSetup({ input, output, outputDir, env: {}, detect,
    loadAdapter: async () => { throw new Error('must not be called'); } });
  assert.equal(result.written, false);
  await assert.rejects(readFile(join(outputDir, 'policy.json'), 'utf8'));
});

test('an invalid audit retention answer is rejected and re-asked rather than silently accepted', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'triview-setup-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { input, output } = io(['yes', 'no', 'no', 'no', 'no', 'no', 'no', 'fake/module.js', 'createFakeAdapter', '',
    'no', 'yes', '/var/log/triview', 'not-a-number', '-1', '3651', '30', 'yes']);
  const loadAdapter = async () => fakeAdapter({ providerId: 'local-provider', modelId: 'local-model', dataHandling: 'local' });
  const result = await runSetup({ input, output, outputDir, env: {}, loadAdapter });
  assert.equal(result.written, true);
  assert.ok(result.command.includes('--retention-days'));
  assert.equal(result.command[result.command.indexOf('--retention-days') + 1], '30');
});
