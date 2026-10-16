import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClaudeCodeModelAdapter } from '../src/adapters/model/claude-code.js';
import { createCliModelAdapters } from '../src/cli/review.js';
import { runStaticReview } from '../src/core/static-review.js';

const basePolicy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));
const subscription = { loggedIn: true, authMethod: 'claude.ai',
  apiProvider: 'firstParty', subscriptionType: 'pro' };

function fakeSpawn(calls, responsePatch = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    const parts = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { parts.push(chunk); done(); } });
    child.stdin.on('finish', () => {
      if (args[0] === '--version') {
        child.stdout.end('2.1.300 (Claude Code)\n');
        setImmediate(() => child.emit('close', 0));
        return;
      }
      const prompt = JSON.parse(Buffer.concat(parts).toString('utf8'));
      calls.push({ command, args, options, prompt });
      const result = { is_error: false, session_id: `session-${calls.length}`,
        structured_output: { findings: [], verdict: 'recommend-approval' }, ...responsePatch };
      child.stdout.end(JSON.stringify(result));
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}

test('Claude Code adapter starts three independent tool-free sessions with only sanitized prompts', async () => {
  const policy = structuredClone(basePolicy);
  policy.dataPolicy = { mode: 'approved-hosted', selectedProvider: 'anthropic-claude-code',
    allowedProviders: ['anthropic-claude-code'] };
  policy.budgets.maxInputTokensPerReviewer = 100000;
  const calls = [];
  const modelAdapter = createClaudeCodeModelAdapter({ modelId: 'sonnet',
    contextWindowTokens: 200000, cwd: '/tmp', spawnImpl: fakeSpawn(calls),
    authCheck: async () => subscription });
  const request = { contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/example.js', changeType: 'added', content: 'export const answer = 42;\n' },
  ] } };
  const report = await runStaticReview({ request, policy, modelAdapter });
  assert.equal(report.status, 'complete');
  assert.equal(calls.length, 3);
  assert.equal(new Set(report.reviewers.map((item) => item.contextId)).size, 3);
  for (const call of calls) {
    assert.equal(call.command, 'claude');
    assert.equal(call.options.killSignal, 'SIGKILL');
    assert.equal(call.args.includes('--no-session-persistence'), true);
    assert.equal(call.args.includes('--safe-mode'), true);
    assert.equal(call.args.includes('--restricted'), true);
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.equal(call.prompt.files[0].content.includes('answer = 42'), true);
    const schema = JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]);
    assert.equal(schema.properties.findings.items.properties.evidence.oneOf[0].properties.path.const, 'F0001');
    assert.equal(schema.properties.findings.items.properties.evidence.oneOf[0].properties.endLine.maximum, 1);
    assert.deepEqual(schema.properties.findings.items.properties.skill.enum, call.prompt.skills.map((skill) => skill.id));
    assert.equal(JSON.stringify(call.prompt).includes('src/example.js'), false);
  }
});

test('role routes select separate Claude account profiles and models', async () => {
  const policy = structuredClone(basePolicy);
  policy.dataPolicy = { mode: 'approved-hosted', allowedProviders: ['anthropic-claude-code'],
    roleRoutes: {
      'code-quality': { adapterId: 'account-personal', providerId: 'anthropic-claude-code',
        modelId: 'sonnet', dataHandling: 'hosted' },
      security: { adapterId: 'account-work', providerId: 'anthropic-claude-code',
        modelId: 'opus', dataHandling: 'hosted' },
      performance: { adapterId: 'account-personal', providerId: 'anthropic-claude-code',
        modelId: 'haiku', dataHandling: 'hosted' },
    } };
  policy.budgets.maxInputTokensPerReviewer = 100000;
  const routeConfig = Object.fromEntries(policy.reviewers.map((role) => [role, {
    kind: 'claude-code', adapterId: policy.dataPolicy.roleRoutes[role].adapterId,
    modelId: policy.dataPolicy.roleRoutes[role].modelId,
    contextWindowTokens: 200000,
    configDir: role === 'security' ? '/tmp/claude-work' : '/tmp/claude-personal',
  }]));
  const calls = [];
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousDebug = process.env.CLAUDE_CODE_DEBUG_LOGS_DIR;
  const previousAlias = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  process.env.ANTHROPIC_API_KEY = 'synthetic-key';
  process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = '/tmp/unapproved-trace';
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'unselected-model';
  try {
    const modelAdapters = await createCliModelAdapters(policy, routeConfig, '/tmp',
      { spawnImpl: fakeSpawn(calls), authCheck: async () => subscription });
    const request = { contractVersion: '1.0', input: { kind: 'files', files: [
      { path: 'src/example.js', changeType: 'added', content: 'export const answer = 42;\n' },
    ] } };
    const report = await runStaticReview({ request, policy, modelAdapters });
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.reviewers.map((item) => item.adapter.modelId),
      ['sonnet', 'opus', 'haiku']);
    assert.deepEqual(calls.map((call) => call.options.env.CLAUDE_CONFIG_DIR),
      ['/tmp/claude-personal', '/tmp/claude-work', '/tmp/claude-personal']);
    assert.equal(calls.every((call) => call.options.env.ANTHROPIC_API_KEY === undefined), true);
    assert.equal(calls.every((call) => call.options.env.CLAUDE_CODE_DEBUG_LOGS_DIR === undefined), true);
    assert.equal(calls.every((call) => call.options.env.ANTHROPIC_DEFAULT_SONNET_MODEL === undefined), true);
    assert.deepEqual(calls.map((call) => call.args[call.args.indexOf('--model') + 1]),
      ['sonnet', 'opus', 'haiku']);
    routeConfig.security.adapterId = 'account-personal';
    await assert.rejects(createCliModelAdapters(policy, routeConfig, '/tmp'),
      /One adapter ID cannot refer to two account profiles/u);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousDebug === undefined) delete process.env.CLAUDE_CODE_DEBUG_LOGS_DIR;
    else process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = previousDebug;
    if (previousAlias === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = previousAlias;
  }
});

test('Claude Code rejects a profile without a first-party subscription before prompt preparation', async () => {
  const policy = structuredClone(basePolicy);
  policy.dataPolicy = { mode: 'approved-hosted', selectedProvider: 'anthropic-claude-code',
    allowedProviders: ['anthropic-claude-code'] };
  policy.budgets.maxInputTokensPerReviewer = 100000;
  const calls = [];
  const modelAdapter = createClaudeCodeModelAdapter({ modelId: 'sonnet',
    contextWindowTokens: 200000, cwd: '/tmp', spawnImpl: fakeSpawn(calls),
    authCheck: async () => ({ ...subscription, loggedIn: false }) });
  const request = { contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/example.js', changeType: 'added', content: 'export const answer = 42;\n' },
  ] } };
  await assert.rejects(() => runStaticReview({ request, policy, modelAdapter }),
    (error) => error.code === 'CAPABILITY_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

test('unverified Claude CLI versions refuse before a reviewer prompt is sent', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = fakeSpawn(calls)(command, args, options);
    if (args[0] === '--version') {
      const originalEnd = child.stdout.end.bind(child.stdout);
      child.stdout.end = () => originalEnd('0.0.0 (Claude Code)\n');
    }
    return child;
  };
  const adapter = createClaudeCodeModelAdapter({ modelId: 'sonnet', contextWindowTokens: 200000,
    cwd: '/tmp', spawnImpl, authCheck: async () => subscription });
  await assert.rejects(() => adapter.verifyRuntime(), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(calls.length, 0);
});

test('reported Claude usage over budget cannot return an approved review', async () => {
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  const calls = [];
  const modelAdapter = createClaudeCodeModelAdapter({ modelId: 'sonnet', contextWindowTokens: 200000,
    cwd: '/tmp', authCheck: async () => subscription, spawnImpl: fakeSpawn(calls, {
      usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5000 },
    }) });
  const report = await runStaticReview({ policy, modelAdapter, request: { contractVersion: '1.0',
    input: { kind: 'files', files: [{ path: 'a.js', changeType: 'added', content: 'export const value = 1;' }] } } });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.reviewers.filter((item) => item.status === 'failed').length, 3);
});

test('preflight expiry kills an actual stalled auth child even when it ignores SIGTERM', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'triview-auth-timeout-'));
  const pidFile = join(directory, 'child.pid');
  const command = join(directory, 'claude-stub');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); }
else { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
`);
  chmodSync(command, 0o700);
  let pid;
  t.after(() => {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  });
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  policy.budgets.timeoutSeconds = 2;
  const modelAdapter = createClaudeCodeModelAdapter({ command, modelId: 'sonnet',
    contextWindowTokens: 200000, cwd: directory });
  const report = await runStaticReview({ policy, modelAdapter, preflightOnly: true,
    request: { contractVersion: '1.0', input: { kind: 'files', files: [
      { path: 'a.js', changeType: 'added', content: 'export const value = 1;' },
    ] } } });
  assert.equal(report.status, 'refused');
  assert.equal(report.code, 'ADAPTER_TIMEOUT');
  pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let count = 0; count < 20 && alive; count++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  }
  assert.equal(alive, false);
});
