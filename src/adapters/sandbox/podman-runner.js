import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertReviewBundle, assertReviewPolicy } from '../../core/contracts.js';
import { sanitizeUntrustedText } from '../../core/preflight.js';
import { localPodman, preflightPodmanSandbox } from './podman-preflight.js';

const MAX_OUTPUT_BYTES = 65536;
const MAX_RUN_SECONDS = 300;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)[^\u0000-\u001f\u007f:]+$/u;

function skipped(reason) {
  return Object.freeze({ status: 'skipped', reason });
}

function failed(reason) {
  return Object.freeze({ status: 'failed', reason });
}

function validCommand(command) {
  return Array.isArray(command) && command.length > 0 && command.length <= 32
    && command.every((part) => typeof part === 'string' && part.length > 0
      && part.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(part));
}


function materialize(bundle) {
  const included = bundle.files.filter((file) => file.state === 'included' && file.changeType !== 'deleted');
  if (included.length === 0 || included.some((file) => !PATH.test(file.path)
    || createHash('sha256').update(file.content).digest('hex') !== file.contentSha256)) {
    return undefined;
  }
  const root = mkdtempSync(join(tmpdir(), 'triview-sandbox-'));
  try {
    if (/[:,]/u.test(root)) throw new Error('unsupported temporary path');
    for (const file of included) {
      const destination = join(root, file.path);
      const parent = dirname(destination);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.content, { flag: 'wx', mode: 0o400 });
    }
    return root;
  } catch {
    rmSync(root, { recursive: true, force: true });
    return undefined;
  }
}

function argumentsFor({ image, root, command, userId, groupId, timeoutSeconds }) {
  return [
    'run', '--rm', '--pull=never', '--image-volume=ignore', '--network=none', '--http-proxy=false',
    '--read-only', '--read-only-tmpfs=false', '--userns=keep-id',
    `--user=${userId}:${groupId}`, '--cap-drop=all',
    '--security-opt=no-new-privileges', '--seccomp-policy=default',
    '--ipc=private', '--pid=private', '--log-driver=none',
    '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=64',
    `--timeout=${timeoutSeconds}`,
    `--volume=${root}:/src:ro,nosuid,nodev`,
    '--tmpfs=/scratch:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--workdir=/src', '--unsetenv-all', '--env=HOME=/scratch',
    '--env=TMPDIR=/scratch', '--env=PATH=/usr/local/bin:/usr/bin:/bin',
    `--entrypoint=${command[0]}`, image, ...command.slice(1),
  ];
}

// This executes only the sanitized, included captured files, never a host checkout.
export function runPodmanSandbox({ policy, bundle, image, command, scan,
  platform = process.platform, runPodman = localPodman,
  userId = process.getuid?.(), groupId = process.getgid?.() } = {}) {
  assertReviewPolicy(policy);
  assertReviewBundle(bundle);
  if (policy.sandbox.executionRequested !== true) return skipped('Sandbox execution was not requested.');
  if (!validCommand(command)) return skipped('An explicit bounded command is required.');
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(groupId) || groupId < 1) {
    return skipped('A non-root local user and group are required.');
  }
  const timeoutSeconds = Math.min(policy.budgets.timeoutSeconds, MAX_RUN_SECONDS);
  const ready = preflightPodmanSandbox({ policy, image, platform, runPodman });
  if (ready.status !== 'ready') return ready;
  let root;
  try {
    root = materialize(bundle);
  } catch {
    return skipped('The sanitized snapshot could not be materialized safely.');
  }
  if (!root) return skipped('The sanitized snapshot could not be materialized safely.');
  try {
    let result;
    try {
      result = runPodman(argumentsFor({ image: ready.image, root, command,
        userId, groupId, timeoutSeconds }),
      { timeoutMs: (timeoutSeconds + 5) * 1000, maxOutputBytes: MAX_OUTPUT_BYTES });
    } catch {
      return failed('The sandbox could not start or finish.');
    }
    if (result?.error || !Number.isInteger(result?.status)
      || typeof result?.stdout !== 'string' || typeof result?.stderr !== 'string'
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) {
      return failed('The sandbox timed out, failed, or exceeded its output limit.');
    }
    if ([125, 126, 127].includes(result.status)) {
      return failed('The sandbox could not start the selected command.');
    }
    let stdout;
    let stderr;
    try {
      stdout = sanitizeUntrustedText(result.stdout, { scan }).content;
      stderr = sanitizeUntrustedText(result.stderr, { scan }).content;
    } catch {
      return failed('Sandbox output could not be scanned safely.');
    }
    return Object.freeze({ status: result.status === 0 ? 'completed' : 'failed',
      profile: ready.profile, imageSha256: ready.imageSha256,
      snapshotScope: 'included-sanitized-files', exitCode: result.status,
      stdout, stderr,
      ...(result.status === 0 ? {} : { reason: 'The sandboxed command exited unsuccessfully.' }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function createPodmanSandboxAdapter(runtime = {}) {
  return Object.freeze({
    preflight: ({ policy, image }) => preflightPodmanSandbox({ ...runtime, policy, image }),
    runVerification: (args) => runPodmanSandbox({ ...runtime, ...args }),
  });
}
