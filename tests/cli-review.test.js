import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { main } from '../src/cli/review.js';

test('missing or implicit harness refuses before review, with no input or module loading', async () => {
  let calls = 0;
  const dependencies = { interactive: false, runReview: () => { calls++; } };
  const base = ['--request', '/missing/request.json', '--policy', '/missing/policy.json'];
  await assert.rejects(main(base, dependencies), /Choose a harness explicitly/u);
  await assert.rejects(main([...base, '--model', 'sonnet', '--context-window', '200000'], dependencies),
    /Choose a harness explicitly/u);
  await assert.rejects(main([...base, '--harness', 'unknown', '--model', 'x', '--context-window', '200000'], dependencies),
    /Choose a harness explicitly/u);
  assert.equal(calls, 0);
});

test('terminal harness prompt selects a generic adapter, explicit Claude, or routes without making model calls', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-harness-choice-'));
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, 'policy.json'), readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  await writeFile(join(directory, 'request.json'), '{}');
  const modulePath = join(directory, 'adapter.mjs');
  await writeFile(modulePath, `export function createAdapter(config) {
    return { getCapabilities: () => ({ modelId: config.marker }), verifyRuntime: () => ({}),
      prepareRequest: () => '{}', countInputTokens: () => ({ upperBound: 1, conservative: true }),
      invokeReview: () => { throw new Error('No live calls allowed'); } };
  }`);
  await writeFile(join(directory, 'config.json'), JSON.stringify({ marker: 'user-choice' }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-multi-route-policy.json', import.meta.url)));
  await writeFile(join(directory, 'routed-policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'routes.json'), JSON.stringify(Object.fromEntries(policy.reviewers.map(role =>
    [role, { kind: 'adapter-module', module: modulePath, export: 'createAdapter', config: { marker: role } }]))));
  let transcript = '';
  let output = '';
  let captured;
  const run = async (answers, policyName = 'policy.json', extra = []) => main([
    '--request', join(directory, 'request.json'), '--policy', join(directory, policyName), ...extra,
  ], { interactive: true, stdin: Readable.from([answers]),
    stdout: { write: value => { output += value; } }, stderr: { write: value => { transcript += value; } },
    runReview: async args => { captured = args; return { status: 'complete' }; } });
  await run(`${modulePath}\ncreateAdapter\n${join(directory, 'config.json')}\n`);
  assert.equal(captured.modelAdapter.getCapabilities().modelId, 'user-choice');
  assert.match(transcript, /No harness is selected by default/u);
  assert.equal(JSON.parse(output).status, 'complete');
  assert.equal(output.includes('Choose'), false, 'prompts must stay out of stdout');
  await run('claude-code\nsonnet\n200000\n');
  assert.equal(captured.modelAdapter.getCapabilities().providerId, 'anthropic-claude-code');
  await run(`routes\n${join(directory, 'routes.json')}\n`, 'routed-policy.json');
  assert.equal(captured.modelAdapters.security.getCapabilities().modelId, 'security');
  transcript = '';
  await run('', 'policy.json', ['--adapter-module', modulePath, '--adapter-export', 'createAdapter']);
  assert.equal(transcript, '', 'explicit runtime selection must not prompt again');
  await assert.rejects(run('cancel\n'), /selection cancelled/u);
  await assert.rejects(run('none\n'), /No current-harness integration/u);
  await assert.rejects(run(''), /selection cancelled/u);
  await assert.rejects(run('claude-code\nsonnet\n'), /selection cancelled/u);
});

test('CLI discloses the explicit sandbox configuration and passes it to the workflow', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  policy.sandbox = { executionRequested: true, backend: 'podman', network: 'disabled' };
  const config = { image: `docker.io/library/python@sha256:${'a'.repeat(64)}`,
    command: ['/usr/local/bin/python', '/src/check.py'] };
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), JSON.stringify({ contractVersion: '1.0',
    input: { kind: 'files', files: [{ path: 'check.py', changeType: 'added', content: 'print(42)' }] } }));
  await writeFile(join(directory, 'sandbox.json'), JSON.stringify(config));
  const argv = ['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json'),
    '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000', '--sandbox-config', join(directory, 'sandbox.json')];
  let disclosed = '';
  let output = '';
  let calls = 0;
  const dependencies = { stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { disclosed += value; } },
    runReview: async (args) => {
      calls++;
      assert.deepEqual(args.sandbox, config);
      assert.ok(disclosed.includes(config.image));
      assert.ok(disclosed.includes('/src/check.py'));
      return { status: 'complete', sandbox: { status: 'completed' } };
    } };
  await main(argv, dependencies);
  assert.equal(JSON.parse(output).sandbox.status, 'completed');
  policy.sandbox = { executionRequested: false, backend: 'none', network: 'disabled' };
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await assert.rejects(() => main(argv, dependencies), /execution opt-in/u);
  assert.equal(calls, 1);
  config.command.push(`ghp_${'A'.repeat(36)}`);
  await writeFile(join(directory, 'sandbox.json'), JSON.stringify(config));
  await assert.rejects(() => main(argv, dependencies), { code: 'INVALID_SANDBOX_CONFIG' });
  assert.equal(disclosed.includes('ghp_'), false);
});

test('CLI preflight-only produces a readable refusal and rejects invalid mode values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-preflight-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url));
  await writeFile(join(directory, 'policy.json'), policy);
  await writeFile(join(directory, 'request.json'), '{}');
  const argv = ['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json'),
    '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000', '--preflight-only', 'true', '--format', 'text'];
  let output = '';
  let errors = '';
  const savedExit = process.exitCode;
  try {
    await main(argv, { stdout: { write: (value) => { output += value; } },
      stderr: { write: (value) => { errors += value; } }, runReview: async (args) => {
        assert.equal(args.preflightOnly, true);
        const result = { kind: 'preflight', status: 'refused', code: 'CAPABILITY_UNAVAILABLE', reason: 'Required isolation is unavailable.' };
        await args.onPreflight(result);
        return result;
      } });
    assert.equal(process.exitCode, 2);
    assert.match(output, /Preflight: refused \(CAPABILITY_UNAVAILABLE\)/u);
    assert.equal(errors, '');
    await assert.rejects(() => main([...argv.slice(0, -4), '--preflight-only', 'maybe']), /Preflight-only/u);
  } finally {
    process.exitCode = savedExit;
  }
});

test('CLI help describes subscription and policy configuration without touching a runtime', async () => {
  let output = '';
  await main(['--help'], { stdout: { write: (value) => { output += value; } },
    runReview: () => { throw new Error('must not start'); } });
  assert.match(output, /--preflight-only true/u);
  assert.match(output, /--routes FILE/u);
  assert.match(output, /Metadata-only audit retention/u);
  assert.match(output, /--adapter-module FILE --adapter-export NAME/u);
  assert.match(output, /has no built-in list of other providers/u);
});

test('CLI --adapter-module loads any user-supplied adapter generically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-adapter-module-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), JSON.stringify({ contractVersion: '1.0',
    input: { kind: 'files', files: [{ path: 'check.py', changeType: 'added', content: 'print(42)' }] } }));
  await writeFile(join(directory, 'module.js'), `
    export function createTestAdapter(config) {
      return {
        getCapabilities: () => ({ providerId: config.marker ?? 'test-provider' }),
        verifyRuntime: () => ({ providerId: config.marker ?? 'test-provider' }),
        prepareRequest: () => JSON.stringify({ marker: config.marker }),
        countInputTokens: () => ({ upperBound: 1, conservative: true }),
        invokeReview: async () => ({ status: 'completed' }),
      };
    }
    export const notAFunction = 42;
  `);
  await writeFile(join(directory, 'config.json'), JSON.stringify({ marker: 'distinctive-marker' }));
  const baseArgv = ['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json')];
  let capturedAdapter;
  const dependencies = { stdout: { write: () => {} }, stderr: { write: () => {} },
    runReview: async (args) => {
      capturedAdapter = args.modelAdapter;
      assert.equal(args.modelAdapters, undefined);
      return { status: 'complete' };
    } };
  await main([...baseArgv, '--adapter-module', join(directory, 'module.js'),
    '--adapter-export', 'createTestAdapter', '--adapter-config', join(directory, 'config.json')], dependencies);
  assert.ok(capturedAdapter, 'an adapter must be constructed');
  assert.equal(JSON.parse(capturedAdapter.prepareRequest()).marker, 'distinctive-marker',
    'the adapter-config contents must reach the loaded factory, not any CLI default');

  // --adapter-config is optional; the factory receives {} and must not crash.
  await main([...baseArgv, '--adapter-module', join(directory, 'module.js'),
    '--adapter-export', 'createTestAdapter'], dependencies);

  await assert.rejects(() => main([...baseArgv, '--adapter-module', join(directory, 'module.js')], dependencies),
    /--adapter-export/u);
  await assert.rejects(() => main([...baseArgv, '--adapter-export', 'createTestAdapter'], dependencies),
    /--adapter-export/u);
  await assert.rejects(() => main([...baseArgv, '--adapter-module', join(directory, 'module.js'),
    '--adapter-export', 'missingExport'], dependencies), /must name an exported function/u);
  await assert.rejects(() => main([...baseArgv, '--adapter-module', join(directory, 'module.js'),
    '--adapter-export', 'notAFunction'], dependencies), /must name an exported function/u);
  await assert.rejects(() => main([...baseArgv, '--adapter-module', join(directory, 'module.js'),
    '--adapter-export', 'not a valid identifier'], dependencies), /plain identifier/u);
  await assert.rejects(() => main([...baseArgv, '--adapter-module', join(directory, 'does-not-exist.js'),
    '--adapter-export', 'createTestAdapter'], dependencies), /could not be loaded/u);
  await assert.rejects(() => main([...baseArgv, '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000',
    '--adapter-module', join(directory, 'module.js'), '--adapter-export', 'createTestAdapter'], dependencies),
    /not both/u);
  await assert.rejects(() => main([...baseArgv, '--routes', join(directory, 'routes.json'),
    '--adapter-module', join(directory, 'module.js'), '--adapter-export', 'createTestAdapter'], dependencies),
    /not allowed with them/u);
});

test('CLI --routes accepts a mix of claude-code and generic adapter-module roles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-route-adapter-module-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-multi-route-policy.json', import.meta.url)));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), JSON.stringify({ contractVersion: '1.0',
    input: { kind: 'files', files: [{ path: 'check.py', changeType: 'added', content: 'print(42)' }] } }));
  await writeFile(join(directory, 'module.js'), `
    export function createTestAdapter(config) {
      return {
        getCapabilities: () => ({ providerId: config.marker ?? 'test-provider' }),
        verifyRuntime: () => ({ providerId: config.marker ?? 'test-provider' }),
        prepareRequest: () => JSON.stringify({ marker: config.marker }),
        countInputTokens: () => ({ upperBound: 1, conservative: true }),
        invokeReview: async () => ({ status: 'completed' }),
      };
    }
  `);
  const routes = Object.fromEntries(policy.reviewers.map((role, index) => [role,
    index === 0
      ? { kind: 'adapter-module', module: join(directory, 'module.js'),
        export: 'createTestAdapter', config: { marker: `route-${role}` } }
      : { kind: 'claude-code', adapterId: `account-${role}`, modelId: 'sonnet', contextWindowTokens: 200000 }]));
  await writeFile(join(directory, 'routes.json'), JSON.stringify(routes));
  const baseArgv = ['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json'),
    '--routes', join(directory, 'routes.json')];
  let capturedAdapters;
  const dependencies = { stdout: { write: () => {} }, stderr: { write: () => {} },
    runReview: async (args) => { capturedAdapters = args.modelAdapters; return { status: 'complete' }; } };
  await main(baseArgv, dependencies);
  const firstRole = policy.reviewers[0];
  assert.equal(JSON.parse(capturedAdapters[firstRole].prepareRequest()).marker, `route-${firstRole}`,
    'a generic adapter-module route must receive its own route-level config');
  assert.equal(capturedAdapters[policy.reviewers[1]].getCapabilities().modelId, 'sonnet');
});

test('CLI --adapter-module rejects an adapter missing required methods, and requires --adapter-config to be a JSON object', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-adapter-shape-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), '{}');
  await writeFile(join(directory, 'incomplete.js'),
    'export function createIncomplete() { return { getCapabilities: () => ({}) }; }\n');
  await writeFile(join(directory, 'config-array.json'), '[]');
  const baseArgv = ['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json'),
    '--adapter-module', join(directory, 'incomplete.js'), '--adapter-export', 'createIncomplete'];
  const dependencies = { runReview: () => { throw new Error('must not start'); } };
  await assert.rejects(() => main(baseArgv, dependencies), /required model-adapter contract/u);
  await assert.rejects(() => main([...baseArgv, '--adapter-config', join(directory, 'config-array.json')],
    dependencies), /must contain a JSON object/u);
});

test('CLI --policy-overrides layers repo-level adjustments onto the base policy before dispatch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-overrides-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), JSON.stringify({ contractVersion: '1.0',
    input: { kind: 'files', files: [{ path: 'check.py', changeType: 'added', content: 'print(42)' }] } }));
  await writeFile(join(directory, 'overrides.json'), JSON.stringify({ contractVersion: '1.0',
    reviewers: ['security'], budgets: { maxInputTokensPerReviewer: 5000 } }));
  let capturedPolicy;
  const dependencies = { stdout: { write: () => {} }, stderr: { write: () => {} },
    runReview: async (args) => { capturedPolicy = args.policy; return { status: 'complete' }; } };
  await main(['--request', join(directory, 'request.json'), '--policy', join(directory, 'policy.json'),
    '--policy-overrides', join(directory, 'overrides.json'),
    '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000'], dependencies);
  assert.deepEqual(capturedPolicy.reviewers, ['security']);
  assert.equal(capturedPolicy.mode, 'partial');
  assert.equal(capturedPolicy.budgets.maxInputTokensPerReviewer, 5000);
  assert.equal(capturedPolicy.budgets.maxFiles, policy.budgets.maxFiles);
});

test('CLI --policy-overrides rejects an override that cannot produce a valid policy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-cli-overrides-invalid-'));
  t.after(() => rm(directory, { recursive: true }));
  const policy = JSON.parse(readFileSync(new URL('../examples/claude-code-policy.json', import.meta.url)));
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(directory, 'request.json'), '{}');
  await writeFile(join(directory, 'overrides.json'), JSON.stringify({ contractVersion: '1.0', unknownField: true }));
  const dependencies = { runReview: () => { throw new Error('must not start'); } };
  await assert.rejects(() => main(['--request', join(directory, 'request.json'),
    '--policy', join(directory, 'policy.json'), '--policy-overrides', join(directory, 'overrides.json'),
    '--harness', 'claude-code', '--model', 'sonnet', '--context-window', '200000'], dependencies), /INVALID_POLICY_OVERRIDES/u);
});
