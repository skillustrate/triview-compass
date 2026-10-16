import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createCliModelAdapters } from '../cli/adapter-loader.js';
import { assertHostContext, assertReviewPolicy } from '../core/contracts.js';
import { PreflightError } from '../core/errors.js';
import { freezeBundle, scanSecrets } from '../core/preflight.js';
import { runStaticReview } from '../core/static-review.js';

function refuse(message, code = 'INVALID_HARNESS_SELECTION') {
  throw new PreflightError(code, message);
}

// Host context is trusted configuration, never inferred from reviewed files,
// installed binaries, conversation source, or another provider's presence.
export function describeHostHarnesses(context) {
  assertHostContext(context);
  if (Object.values(context.harnesses).some(item => item.runtime.kind === 'adapter-module' && !isAbsolute(item.runtime.module))) {
    refuse('Host adapter modules must use absolute paths from trusted configuration.', 'INVALID_HOST_CONTEXT');
  }
  const harnesses = Object.entries(context.harnesses).map(([id, item]) => ({
    id, adapterId: item.adapterId, providerId: item.providerId,
    modelId: item.modelId, dataHandling: item.dataHandling,
  }));
  if (scanSecrets(JSON.stringify({ currentHarness: context.currentHarness, harnesses })).length > 0) {
    refuse('Harness display metadata contains a known secret pattern.', 'UNSAFE_HOST_CONTEXT');
  }
  return freezeBundle({ currentHarness: context.currentHarness,
    currentAvailable: Object.hasOwn(context.harnesses, context.currentHarness), harnesses });
}

// [] means the user selected no alternative: use the current harness for
// every selected role, each dispatched into a fresh context by the adapter.
export function createHostReviewPlan(context, selection, basePolicy) {
  describeHostHarnesses(context);
  assertReviewPolicy(basePolicy);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Object.keys(selection).some(key => !['harnesses', 'assignments'].includes(key))
    || !Array.isArray(selection.harnesses) || selection.harnesses.length > 3
    || selection.harnesses.some(id => typeof id !== 'string' || !Object.hasOwn(context.harnesses, id))
    || new Set(selection.harnesses).size !== selection.harnesses.length) {
    refuse('Select no alternatives, or one to three configured harness IDs.');
  }
  if (selection.harnesses.length === 0 && !Object.hasOwn(context.harnesses, context.currentHarness)) {
    refuse('The current harness has no compatible adapter. Choose an explicitly configured alternative.', 'CURRENT_HARNESS_UNAVAILABLE');
  }
  const ids = selection.harnesses.length ? selection.harnesses : [context.currentHarness];
  let assignments = selection.assignments;
  if (assignments === undefined && ids.length === 1) {
    assignments = Object.fromEntries(basePolicy.reviewers.map(role => [role, ids[0]]));
  }
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)
    || Object.keys(assignments).length !== basePolicy.reviewers.length
    || basePolicy.reviewers.some(role => !Object.hasOwn(assignments, role) || !ids.includes(assignments[role]))
    || ids.some(id => !Object.values(assignments).includes(id))) {
    refuse('Assign every reviewer to one selected harness, using every selected harness.');
  }
  const policy = structuredClone(basePolicy);
  if (policy.dataPolicy.mode === 'disallow-model-calls') {
    refuse('The policy disables model calls.', 'MODEL_CALLS_DISABLED');
  }
  const roleRoutes = {};
  const routes = {};
  for (const role of policy.reviewers) {
    const harness = context.harnesses[assignments[role]];
    if (!policy.dataPolicy.allowedProviders.includes(harness.providerId)) {
      refuse('A selected harness provider is not allowed by the policy.', 'PROVIDER_NOT_ALLOWED');
    }
    if (policy.dataPolicy.mode === 'local-only' && harness.dataHandling !== 'local') {
      refuse('A selected harness violates the local-only data policy.', 'DATA_HANDLING_MISMATCH');
    }
    const { adapterId, providerId, modelId, dataHandling } = harness;
    roleRoutes[role] = { adapterId, providerId, modelId, dataHandling };
    routes[role] = structuredClone(harness.runtime);
  }
  // Selection binds the route, but never adds provider permission or alters
  // isolation, scope, budgets, sandbox location, or audit configuration.
  delete policy.dataPolicy.selectedProvider;
  policy.dataPolicy.roleRoutes = roleRoutes;
  assertReviewPolicy(policy);
  return freezeBundle({ policy, routes, assignments: { ...assignments } });
}

// Host SDK entry point: chooseHarnesses can ask through a chat UI instead
// of terminal stdin. No adapter is loaded until an explicit answer exists.
export async function runHostReview({ context, selection, chooseHarnesses, ...options } = {}) {
  const capturedContext = freezeBundle(structuredClone(context));
  const policy = freezeBundle(structuredClone(options.policy));
  const description = describeHostHarnesses(capturedContext);
  assertReviewPolicy(policy);
  if (selection === undefined) {
    if (typeof chooseHarnesses !== 'function') {
      refuse('The host must ask for review harnesses before dispatch.');
    }
    selection = await chooseHarnesses(freezeBundle({ ...description, reviewers: [...policy.reviewers] }));
  }
  const plan = createHostReviewPlan(capturedContext, selection, policy);
  const cwd = await mkdtemp(join(tmpdir(), 'triview-host-'));
  try {
    const modelAdapters = await createCliModelAdapters(plan.policy, plan.routes, cwd);
    return await runStaticReview({ ...options, policy: plan.policy, modelAdapters });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
