import { spawnSync } from 'node:child_process';

const IMAGE = /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:([a-f0-9]{64})$/u;
const MAX_OUTPUT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5000;

function skipped(reason) {
  return Object.freeze({ status: 'skipped', reason,
    guidance: 'https://podman.io/docs/installation' });
}

export function isPinnedImage(image) {
  return typeof image === 'string' && IMAGE.test(image);
}

export function localPodman(args, { timeoutMs = COMMAND_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT } = {}) {
  const env = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]));
  return spawnSync('podman', args, {
    shell: false, encoding: 'utf8', timeout: timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: maxOutputBytes, env,
  });
}

function readJson(result) {
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== 'string'
    || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

// No source is read, mounted, or executed by this preflight. A caller must pass
// the same verified image and profile to the eventual execution backend.
export function preflightPodmanSandbox({ policy, image, platform = process.platform,
  runPodman = localPodman } = {}) {
  if (policy?.sandbox?.executionRequested !== true) {
    return skipped('Sandbox execution was not requested.');
  }
  if (policy.sandbox.backend !== 'podman' || policy.sandbox.network !== 'disabled') {
    return skipped('The requested sandbox policy is unsupported.');
  }
  if (platform !== 'linux') {
    return skipped('The v1 sandbox requires Linux rootless Podman.');
  }
  if (!isPinnedImage(image)) {
    return skipped('A fully qualified image pinned by SHA-256 digest is required.');
  }
  if (typeof runPodman !== 'function') return skipped('The Podman command runner is unavailable.');

  let info;
  try {
    info = readJson(runPodman(['info', '--format', 'json']));
  } catch {
    return skipped('Podman is unavailable or its runtime check failed.');
  }
  if (!info) return skipped('Podman is unavailable or its runtime check failed.');
  if (info.host?.serviceIsRemote !== false || info.host?.security?.rootless !== true) {
    return skipped('Podman is not a verified local rootless engine.');
  }
  if (info.host.security.seccompEnabled !== true || info.host.cgroupVersion !== 'v2') {
    return skipped('Podman lacks required isolation or resource-limit support.');
  }

  let inspected;
  try {
    inspected = readJson(runPodman(['image', 'inspect', image]));
  } catch {
    return skipped('The pinned image is unavailable locally.');
  }
  const details = Array.isArray(inspected) && inspected.length === 1 ? inspected[0] : undefined;
  const expectedDigest = `sha256:${IMAGE.exec(image)[1]}`;
  if (details?.Digest !== expectedDigest || !Array.isArray(details.RepoDigests)
    || !details.RepoDigests.includes(image)) {
    return skipped('The local image identity does not match the pinned digest.');
  }
  return Object.freeze({ status: 'ready', profile: 'linux-rootless-podman-v1',
    image, imageSha256: expectedDigest.slice(7) });
}
