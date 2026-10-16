import { assertPreflightReport } from './contracts.js';
import { freezeBundle, scanSecrets } from './preflight.js';
import { PreflightError } from './errors.js';

const REASONS = {
  CAPABILITY_UNAVAILABLE: 'A selected adapter cannot enforce the required controls or model capacity.',
  CAPABILITY_MISMATCH: 'Adapter identity or control settings changed during runtime verification.',
  POLICY_CHANGED: 'The policy changed during preparation or before dispatch.',
  ADAPTER_FAILED: 'A required adapter preflight operation failed.',
  ADAPTER_TIMEOUT: 'Adapter preflight exceeded its configured time budget.',
  PROVIDER_NOT_ALLOWED: 'An explicit allowlisted provider is required for every selected reviewer.',
  PROVIDER_MISMATCH: 'An adapter does not match its selected provider or model.',
  DATA_HANDLING_MISMATCH: 'An adapter does not match the approved local or hosted data handling.',
  MODEL_CALLS_DISABLED: 'The policy disables model calls.',
  BUDGET_EXCEEDED: 'The configured review budget is insufficient; split the change or explicitly revise the policy.',
  TOKEN_BOUNDS_UNAVAILABLE: 'Conservative input-token bounds are unavailable.',
  INVALID_AUDIT_STORE: 'Audit retention or storage configuration is invalid.',
  INVALID_INPUT: 'The review input is invalid.',
  INVALID_POLICY: 'The review policy is invalid.',
  INVALID_ADAPTER_CONFIG: 'The selected adapter configuration is invalid.',
  INVALID_BUNDLE: 'Captured evidence does not satisfy the immutable review contract.',
  INVALID_REVISION: 'The selected Git revisions cannot form a supported committed change.',
  GIT_CAPTURE_FAILED: 'Git could not capture the requested committed evidence.',
  CAPTURE_TIMEOUT: 'Evidence capture exceeded its configured time budget.',
  SCANNER_TIMEOUT: 'Local scanning exceeded its configured time budget.',
  SCANNER_FAILED: 'Local scanning failed; review cannot proceed with unscanned content.',
  UNSAFE_PREFLIGHT: 'Capability metadata contained a known secret pattern and was withheld.',
  INVALID_SANDBOX_CONFIG: 'Sandbox configuration requires explicit policy opt-in, a pinned image, and a bounded command.',
};

export function refusedPreflight(error) {
  const code = Object.hasOwn(REASONS, error?.code) ? error.code : 'PREFLIGHT_FAILED';
  const report = { contractVersion: '1.0', kind: 'preflight', status: 'refused', code,
    reason: REASONS[code] ?? 'Review preflight failed before reviewer dispatch.' };
  assertPreflightReport(report);
  return freezeBundle(report);
}

export function createPreflightReport(policy, bundle, plan) {
  const report = { contractVersion: '1.0', kind: 'preflight', status: 'ready',
    reviewId: bundle.reviewId, snapshotSha256: bundle.snapshot.sha256,
    policyVersion: plan.policyVersion, mode: policy.mode,
    promptVersions: plan.promptVersions,
    scopeCounts: Object.fromEntries(['included', 'excluded', 'binary', 'generated', 'oversized']
      .map((state) => [state, bundle.files.filter((file) => file.state === state).length])),
    budgets: { ...policy.budgets },
    harness: { adapterId: plan.harnessAdapterId, adapterVersion: plan.harnessAdapterVersion,
      controls: plan.runtimeControls.harness },
    reviewers: policy.reviewers.map((role) => ({ role, ...plan.readiness.routes[role],
      inputTokenUpperBound: plan.readiness.inputTokenBounds[role],
      controls: plan.runtimeControls.models[role] })),
    hostedSourceDisclosure: Object.values(plan.readiness.routes).some((route) => route.dataHandling === 'hosted'),
    limitations: [...plan.readiness.limitations],
  };
  assertSafePreflightReport(report);
  return freezeBundle(report);
}

export function assertSafePreflightReport(report) {
  assertPreflightReport(report);
  if (scanSecrets(JSON.stringify(report)).length > 0) {
    throw new PreflightError('UNSAFE_PREFLIGHT', 'Capability metadata contained a known secret pattern.');
  }
}
