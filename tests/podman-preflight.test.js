import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflightPodmanSandbox } from '../src/adapters/sandbox/podman-preflight.js';

const digest = 'a'.repeat(64);
const image = `docker.io/library/alpine@sha256:${digest}`;
const policy = { sandbox: { executionRequested: true, backend: 'podman', network: 'disabled' } };
const info = { host: { serviceIsRemote: false, cgroupVersion: 'v2',
  security: { rootless: true, seccompEnabled: true } } };

function fakeRunner({ runtime = info, inspected = [{ Digest: `sha256:${digest}`, RepoDigests: [image] }] } = {}) {
  const calls = [];
  return { calls, runPodman(args) {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(args[0] === 'info' ? runtime : inspected) };
  } };
}

test('a local rootless engine and exact pinned image pass source-free preflight', () => {
  const fake = fakeRunner();
  const result = preflightPodmanSandbox({ policy, image, platform: 'linux', runPodman: fake.runPodman });
  assert.deepEqual(result, { status: 'ready', profile: 'linux-rootless-podman-v1',
    image, imageSha256: digest });
  assert.deepEqual(fake.calls, [['info', '--format', 'json'], ['image', 'inspect', image]]);
});

test('unrequested or unsupported execution never calls Podman', () => {
  const fake = fakeRunner();
  assert.equal(preflightPodmanSandbox({ policy: { sandbox: { executionRequested: false } },
    image, platform: 'linux', runPodman: fake.runPodman }).status, 'skipped');
  assert.equal(preflightPodmanSandbox({ policy, image, platform: 'darwin',
    runPodman: fake.runPodman }).status, 'skipped');
  assert.equal(preflightPodmanSandbox({ policy, image: 'alpine:latest', platform: 'linux',
    runPodman: fake.runPodman }).status, 'skipped');
  assert.deepEqual(fake.calls, []);
});

test('remote, rootful, or insufficiently isolated engines refuse before image inspection', () => {
  for (const change of [
    { serviceIsRemote: true },
    { security: { rootless: false, seccompEnabled: true } },
    { security: { rootless: true, seccompEnabled: false } },
    { cgroupVersion: 'v1' },
  ]) {
    const fake = fakeRunner({ runtime: { host: { ...info.host, ...change } } });
    assert.equal(preflightPodmanSandbox({ policy, image, platform: 'linux',
      runPodman: fake.runPodman }).status, 'skipped');
    assert.equal(fake.calls.length, 1);
  }
});

test('missing, failed, or mismatched local image refuses without pulling', () => {
  for (const inspected of [[], [{ Digest: `sha256:${'b'.repeat(64)}`, RepoDigests: [image] }],
    [{ Digest: `sha256:${digest}`, RepoDigests: [] }]]) {
    const fake = fakeRunner({ inspected });
    assert.equal(preflightPodmanSandbox({ policy, image, platform: 'linux',
      runPodman: fake.runPodman }).status, 'skipped');
    assert.deepEqual(fake.calls.map((args) => args[0]), ['info', 'image']);
  }
  const failed = preflightPodmanSandbox({ policy, image, platform: 'linux',
    runPodman: () => ({ status: 124, error: new Error('sensitive stderr') }) });
  assert.equal(failed.status, 'skipped');
  assert.doesNotMatch(failed.reason, /sensitive stderr/u);
});
