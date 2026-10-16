import { assertPolicyOverrides, assertReviewPolicy } from './contracts.js';
import { orderReviewers, reviewModeFor } from './reviewer-order.js';

// Layers a small, partial overrides document onto an already-valid review
// policy -- for adopters who want to adjust a few fields (budgets, path
// exclusions, reviewer subset, sandbox opt-in) without maintaining a
// duplicate full policy file. The result is always re-validated against the
// full policy schema before being returned: this can never produce an
// otherwise-invalid policy, it can only ever produce a different valid one.
export function applyPolicyOverrides(policy, overrides) {
  assertReviewPolicy(policy);
  assertPolicyOverrides(overrides);

  const merged = structuredClone(policy);

  if (overrides.reviewers !== undefined) {
    merged.reviewers = orderReviewers(overrides.reviewers);
    merged.mode = reviewModeFor(merged.reviewers);
  }
  if (overrides.budgets !== undefined) {
    merged.budgets = { ...merged.budgets, ...overrides.budgets };
  }
  if (overrides.pathPolicy !== undefined) {
    merged.pathPolicy = { ...merged.pathPolicy, excludedPathGlobs: overrides.pathPolicy.excludedPathGlobs };
  }
  if (overrides.sandbox !== undefined) {
    merged.sandbox = { ...overrides.sandbox };
  }

  assertReviewPolicy(merged);
  return merged;
}
