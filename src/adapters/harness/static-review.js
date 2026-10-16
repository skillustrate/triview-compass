import { policyVersion } from '../../core/audit.js';
import { assertReviewBundle, assertReviewPolicy } from '../../core/contracts.js';
import { PreflightError } from '../../core/errors.js';

const CAPABILITIES = Object.freeze({ contractVersion: '1.0',
  adapterId: 'static-review-harness', adapterType: 'harness', adapterVersion: '1.0',
  limitations: Object.freeze([]), controls: Object.freeze({
    readOnlyInput: 'enforced', noAgentWrite: 'enforced', noAgentExecution: 'enforced',
    noAgentNetwork: 'enforced', freshContextPerReviewer: 'enforced',
    crossSessionMemoryDisabled: 'enforced',
  }) });

function refuse() {
  throw new PreflightError('HARNESS_SCOPE_CHANGED', 'The static review scope changed.');
}

function deeplyFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

// The static harness has no agent runtime or tool entry point. Reviewers get
// only serialized prompts built from this frozen bundle, and the model adapter
// sends them without tools or previous conversation state.
export function createStaticReviewHarnessAdapter({ policy, bundle } = {}) {
  assertReviewPolicy(policy);
  assertReviewBundle(bundle);
  if (!deeplyFrozen(bundle) || bundle.mode !== policy.mode
    || bundle.reviewers.length !== policy.reviewers.length
    || policy.reviewers.some((role) => !bundle.reviewers.includes(role))) refuse();
  const bound = Object.freeze({ policyVersion: policyVersion(policy),
    reviewId: bundle.reviewId, snapshotSha256: bundle.snapshot.sha256,
    mode: bundle.mode, reviewers: Object.freeze([...bundle.reviewers]) });
  function assertScope(scope) {
    if (!scope || scope.policyVersion !== bound.policyVersion
      || scope.reviewId !== bound.reviewId || scope.snapshotSha256 !== bound.snapshotSha256
      || scope.mode !== bound.mode || !Array.isArray(scope.reviewers)
      || scope.reviewers.length !== bound.reviewers.length
      || bound.reviewers.some((role) => !scope.reviewers.includes(role))) refuse();
  }
  function verifyRuntime() {
    if (!deeplyFrozen(bundle) || policyVersion(policy) !== bound.policyVersion
      || bundle.reviewId !== bound.reviewId || bundle.snapshot.sha256 !== bound.snapshotSha256) refuse();
    return CAPABILITIES;
  }
  return Object.freeze({ getCapabilities: () => CAPABILITIES, verifyRuntime, assertScope });
}
