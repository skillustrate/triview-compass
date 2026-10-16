import { assertAdapterCapabilities, assertReviewPolicy } from './contracts.js';
import { PreflightError } from './errors.js';
import { scanSecrets } from './preflight.js';

const HARNESS_CONTROLS = [
  'readOnlyInput', 'noAgentWrite', 'noAgentExecution', 'noAgentNetwork',
  'freshContextPerReviewer', 'crossSessionMemoryDisabled',
];
const MODEL_CONTROLS = ['freshContextPerReviewer', 'crossSessionMemoryDisabled'];

function refuse(code, message) {
  throw new PreflightError(code, message);
}

function requireControls(adapter, names) {
  if (names.some((name) => adapter.controls[name] !== 'enforced')) {
    refuse('CAPABILITY_UNAVAILABLE', 'An adapter does not enforce all required model-review controls.');
  }
}

function selectedRoutes(policy, models) {
  const configured = policy.dataPolicy.roleRoutes;
  if (configured !== undefined) {
    if (policy.dataPolicy.selectedProvider !== undefined
      || Object.keys(configured).length !== policy.reviewers.length
      || policy.reviewers.some((role) => !Object.hasOwn(configured, role))) {
      refuse('PROVIDER_NOT_ALLOWED', 'Select exactly one explicit route for every reviewer.');
    }
    return configured;
  }
  const selected = policy.dataPolicy.selectedProvider;
  if (!selected || !policy.dataPolicy.allowedProviders.includes(selected)) {
    refuse('PROVIDER_NOT_ALLOWED', 'Select an allowlisted provider before model review.');
  }
  return Object.fromEntries(policy.reviewers.map((role) => [role, {
    providerId: selected, modelId: models?.[role]?.modelId,
    adapterId: models?.[role]?.adapterId,
    dataHandling: policy.dataPolicy.mode === 'local-only' ? 'local' : 'hosted',
  }]));
}

export function assertRoutedModelPreflight(policy, { harness, models, inputTokenBounds } = {}) {
  assertReviewPolicy(policy);
  if (policy.dataPolicy.mode === 'disallow-model-calls') {
    refuse('MODEL_CALLS_DISABLED', 'The policy disables model calls.');
  }
  if (policy.budgets.maxModelCalls < policy.reviewers.length) {
    refuse('BUDGET_EXCEEDED', 'The call budget cannot cover every selected reviewer.');
  }
  assertAdapterCapabilities(harness);
  if (harness.adapterType !== 'harness') {
    refuse('PROVIDER_MISMATCH', 'The harness adapter type does not match the policy.');
  }
  requireControls(harness, HARNESS_CONTROLS);
  if (!models || typeof models !== 'object' || Array.isArray(models)
    || Object.keys(models).length !== policy.reviewers.length
    || policy.reviewers.some((role) => !Object.hasOwn(models, role))) {
    refuse('PROVIDER_MISMATCH', 'Every reviewer needs one selected model adapter.');
  }
  if (!inputTokenBounds || typeof inputTokenBounds !== 'object' || Array.isArray(inputTokenBounds)
    || Object.keys(inputTokenBounds).length !== policy.reviewers.length) {
    refuse('TOKEN_BOUNDS_UNAVAILABLE', 'Conservative token bounds are required for every reviewer.');
  }
  const expected = selectedRoutes(policy, models);
  const routed = policy.dataPolicy.roleRoutes !== undefined;
  const routes = {};
  const limitations = [];
  for (const role of policy.reviewers) {
    const model = models[role];
    assertAdapterCapabilities(model);
    const route = expected[role];
    if (model.adapterType !== 'model' || model.providerId !== route.providerId
      || model.modelId !== route.modelId || model.adapterId !== route.adapterId
      || !policy.dataPolicy.allowedProviders.includes(route.providerId)) {
      refuse('PROVIDER_MISMATCH', 'A reviewer route does not match its selected provider and model.');
    }
    if (model.dataHandling !== route.dataHandling
      || (policy.dataPolicy.mode === 'local-only' && route.dataHandling !== 'local')) {
      refuse('DATA_HANDLING_MISMATCH', 'A reviewer route does not match its approved data handling.');
    }
    requireControls(model, MODEL_CONTROLS);
    if (model.maxOutputTokens < policy.budgets.maxOutputTokensPerReviewer) {
      refuse('CAPABILITY_UNAVAILABLE', 'A model output limit is below the policy budget.');
    }
    const count = inputTokenBounds[role];
    if (!Number.isSafeInteger(count) || count < 0) {
      refuse('TOKEN_BOUNDS_UNAVAILABLE', 'A reviewer token bound is missing or invalid.');
    }
    if (count > policy.budgets.maxInputTokensPerReviewer) {
      refuse('BUDGET_EXCEEDED', 'A reviewer prompt exceeds its input-token budget; split the change.');
    }
    if (count + policy.budgets.maxOutputTokensPerReviewer > model.contextWindowTokens) {
      refuse('CAPABILITY_UNAVAILABLE', 'A model context window cannot hold the bounded prompt and output.');
    }
    routes[role] = Object.freeze({ adapterId: model.adapterId, providerId: model.providerId,
      modelId: model.modelId, dataHandling: model.dataHandling,
      adapterVersion: model.adapterVersion });
    for (const limitation of model.limitations) {
      limitations.push(`${role}: ${scanSecrets(limitation).length ? 'Adapter limitation withheld because it contained a known secret pattern.' : limitation.slice(0, 1000)}`);
    }
    if (model.controls.structuredOutput !== 'enforced') {
      limitations.push(routed ? `${role}: structured output is not enforced by the model adapter`
        : 'structured output is not enforced by the model adapter');
    }
    if (model.controls.usageReporting !== 'enforced') {
      limitations.push(routed ? `${role}: model usage reporting is unavailable`
        : 'model usage reporting is unavailable');
    }
  }
  const first = routes[policy.reviewers[0]];
  return Object.freeze({
    ...first,
    routes: Object.freeze(routes),
    inputTokenBounds: Object.freeze({ ...inputTokenBounds }),
    limitations: Object.freeze([...new Set(limitations)]),
  });
}

// Legacy single-adapter entry point remains available to existing callers.
export function assertModelPreflight(policy, { harness, model, inputTokenBounds } = {}) {
  return assertRoutedModelPreflight(policy, { harness,
    models: Object.fromEntries(policy.reviewers.map((role) => [role, model])),
    inputTokenBounds });
}
