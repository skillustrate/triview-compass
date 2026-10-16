import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { preflightFiles } from '../src/core/preflight.js';
import { runPodmanSandbox } from '../src/adapters/sandbox/podman-runner.js';

const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));
policy.sandbox = { executionRequested: true, backend: 'podman', network: 'disabled' };
const digest = 'a'.repeat(64);
const image = `docker.io/library/alpine@sha256:${digest}`;
const command = ['/bin/sh', '-c', 'cat src/a.js'];
const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'src/a.js', changeType: 'added', content: 'const answer = 42;\n' },
  { path: '.env', changeType: 'added', content: 'SECRET_ONLY_IN_EXCLUDED_PATH\n' },
] } }, policy);

function fakePodman(onRun = () => ({ status: 0, stdout: 'ok\n', stderr: '' })) {
  const calls = [];
  return { calls, runPodman(args, options) {
    calls.push({ args, options });
    if (args[0] === 'info') return { status: 0, stdout: JSON.stringify({ host: {
      serviceIsRemote: false, cgroupVersion: 'v2',
      security: { rootless: true, seccompEnabled: true },
    } }) };
    if (args[0] === 'image') return { status: 0, stdout: JSON.stringify([{
      Digest: `sha256:${digest}`, RepoDigests: [image],
    }]) };
    return onRun(args, options);
  } };
}

test('runs only the sanitized captured snapshot with bounded Podman controls', () => {
  let mounted;
  const fake = fakePodman((args, options) => {
    const volume = args.find((part) => part.startsWith('--volume='));
    mounted = volume.slice('--volume='.length).split(':/src:')[0];
    assert.equal(readFileSync(join(mounted, 'src/a.js'), 'utf8'), 'const answer = 42;\n');
    assert.equal(existsSync(join(mounted, '.env')), false);
    assert.equal(volume.endsWith(':/src:ro,nosuid,nodev'), true);
    for (const required of ['--pull=never', '--image-volume=ignore', '--network=none', '--read-only',
      '--read-only-tmpfs=false', '--userns=keep-id', '--cap-drop=all',
      '--security-opt=no-new-privileges', '--seccomp-policy=default',
      '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=64',
      '--log-driver=none', '--unsetenv-all', '--http-proxy=false',
      '--workdir=/src', '--entrypoint=/bin/sh']) assert.ok(args.includes(required), required);
    assert.ok(args.some((part) => part.startsWith('--tmpfs=/scratch:') && part.includes('size=64m')));
    assert.ok(args.some((part) => part.startsWith('--timeout=')));
    assert.equal(args.at(-2), '-c');
    assert.equal(args.at(-1), 'cat src/a.js');
    assert.equal(options.maxOutputBytes, 65536);
    return { status: 0, stdout: 'ok\n', stderr: '' };
  });
  const result = runPodmanSandbox({ policy, bundle, image, command, platform: 'linux',
    runPodman: fake.runPodman, userId: 1000, groupId: 1000 });
  assert.equal(result.status, 'completed');
  assert.equal(result.snapshotScope, 'included-sanitized-files');
  assert.equal(existsSync(mounted), false);
  assert.deepEqual(fake.calls.map(({ args }) => args[0]), ['info', 'image', 'run']);
});

test('refuses an unsafe command or unavailable runtime before any source mount', () => {
  const fake = fakePodman();
  assert.equal(runPodmanSandbox({ policy, bundle, image, command: [], platform: 'linux',
    runPodman: fake.runPodman, userId: 1000, groupId: 1000 }).status, 'skipped');
  assert.equal(runPodmanSandbox({ policy, bundle, image, command, platform: 'darwin',
    runPodman: fake.runPodman, userId: 1000, groupId: 1000 }).status, 'skipped');
  assert.deepEqual(fake.calls, []);
});

test('scans container output before returning it and withholds scanner failures', () => {
  const secret = `ghp_${'A'.repeat(36)}`;
  const fake = fakePodman(() => ({ status: 0, stdout: `value ${secret}`, stderr: '' }));
  const args = { policy, bundle, image, command, platform: 'linux',
    runPodman: fake.runPodman, userId: 1000, groupId: 1000 };
  const result = runPodmanSandbox(args);
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(result.stdout, /ghp_/u);
  assert.match(result.stdout, /\[REDACTED: credential\]/u);
  const bad = runPodmanSandbox({ ...args, scan: () => { throw new Error(secret); } });
  assert.equal(bad.status, 'failed');
  assert.equal(JSON.stringify(bad).includes(secret), false);
});

test('startup, timeout, oversized output, and nonzero exit fail without host fallback', () => {
  for (const outcome of [
    { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' },
    { status: 0, stdout: 'x'.repeat(65537), stderr: '' },
    { status: 125, stdout: '', stderr: 'container startup failed' },
  ]) {
    const fake = fakePodman(() => outcome);
    const result = runPodmanSandbox({ policy, bundle, image, command, platform: 'linux',
      runPodman: fake.runPodman, userId: 1000, groupId: 1000 });
    assert.equal(result.status, 'failed');
    assert.deepEqual(fake.calls.map(({ args }) => args[0]), ['info', 'image', 'run']);
    assert.equal(JSON.stringify(result).includes('container startup failed'), false);
  }
});
