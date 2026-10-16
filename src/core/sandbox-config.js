import { PreflightError } from './errors.js';
import { scanSecrets } from './preflight.js';

const IMAGE = /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:([a-f0-9]{64})$/u;
export function isPinnedImage(image) {
  return typeof image === 'string' && IMAGE.test(image);
}
function validCommand(command) {
  return Array.isArray(command) && command.length > 0 && command.length <= 32
    && command.every((part) => typeof part === 'string' && part.length > 0
      && part.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(part));
}

export function assertSandboxConfiguration(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !['image', 'command'].includes(key))
    || !isPinnedImage(config.image) || !validCommand(config.command)
    || config.command.some((part) => scanSecrets(part).length > 0)) {
    throw new PreflightError('INVALID_SANDBOX_CONFIG', 'A pinned image and explicit command without credentials are required.');
  }
}
