import { performance } from 'node:perf_hooks';
import { PreflightError } from './errors.js';

export function captureDeadline(policy) {
  return performance.now() + policy.budgets.timeoutSeconds * 1000;
}

export function remainingTime(deadline, code) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) {
    throw new PreflightError(code, 'Preflight exceeded its configured time limit.');
  }
  // Node's subprocess and VM timeout options require a signed 32-bit value.
  return Math.min(remaining, 2147483647);
}
