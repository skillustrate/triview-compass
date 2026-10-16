import { createHash } from 'node:crypto';
import { assertAdapterCapabilities, assertReviewBundle, assertReviewPolicy } from './contracts.js';
import { policyVersion } from './audit.js';
import { PreflightError } from './errors.js';
import { assertRoutedModelPreflight } from './model-preflight.js';
import { selectModelAdapters } from './model-routing.js';
import { captureDeadline, remainingTime } from './deadline.js';

function refuse(code, message) {
  throw new PreflightError(code, message);
}

async function callAdapter(adapter, method, argument, deadline) {
  let timer;
  const controller = new AbortController();
  try {
    if (!adapter || typeof adapter[method] !== 'function') throw new Error('missing method');
    const timeoutMs = remainingTime(deadline, 'ADAPTER_TIMEOUT');
    return await Promise.race([
      Promise.resolve().then(() => adapter[method]({ ...argument, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PreflightError('ADAPTER_TIMEOUT', 'Adapter preflight exceeded its configured time limit.'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error?.code === 'ADAPTER_TIMEOUT') {
      refuse('ADAPTER_TIMEOUT', 'Adapter preflight exceeded its configured time limit.');
    }
    if (error instanceof PreflightError && ['CAPABILITY_UNAVAILABLE', 'TOKEN_BOUNDS_UNAVAILABLE', 'INVALID_ADAPTER_CONFIG'].includes(error.code)) {
      refuse(error.code, 'A selected adapter could not enforce its required profile.');
    }
    // Adapter exceptions may contain source or provider secrets.
    refuse('ADAPTER_FAILED', 'A required adapter handshake operation failed.');
  } finally {
    clearTimeout(timer);
  }
}

function sameIdentity(declared, active) {
  return ['contractVersion', 'adapterId', 'adapterType', 'adapterVersion', 'providerId', 'modelId']
    .every((name) => declared[name] === active[name]);
}

function verifyRuntime(declared, active) {
  assertAdapterCapabilities(declared);
  assertAdapterCapabilities(active);
  if (!sameIdentity(declared, active)) {
    refuse('CAPABILITY_MISMATCH', 'Adapter identity changed between declaration and runtime verification.');
  }
  if (declared.dataHandling !== undefined && declared.dataHandling !== 'hosted-configurable'
    && declared.dataHandling !== active.dataHandling) {
    refuse('DATA_HANDLING_MISMATCH', 'Adapter data handling changed from its declaration.');
  }
  for (const [name, state] of Object.entries(active.controls)) {
    if (state === 'enforced' && declared.controls[name] === 'unsupported') {
      refuse('CAPABILITY_MISMATCH', 'An unsupported control cannot become enforced at runtime.');
    }
  }
}

function requirePrompts(prompts, roles) {
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)
    || Object.keys(prompts).length !== roles.length) {
    refuse('INVALID_PROMPT_SET', 'The prompt set must contain every selected reviewer exactly once.');
  }
  for (const role of roles) {
    if (!Object.hasOwn(prompts, role) || typeof prompts[role] !== 'string' || prompts[role].length === 0) {
      refuse('INVALID_PROMPT_SET', 'A selected reviewer has no prepared prompt.');
    }
  }
}

// The trusted caller supplies prompts derived only from the sanitized bundle.
// prepareRequest must return the exact immutable UTF-8 wire payload that a
// future dispatcher will send; countInputTokens must conservatively bound it.
// No reviewer inference starts here; trusted runtime and tokenizer methods may query selected services.
export async function prepareAdapterHandshake(policy, bundle, {
  harnessAdapter, modelAdapter, modelAdapters, prompts,
} = {}) {
  assertReviewPolicy(policy);
  const deadline = captureDeadline(policy);
  const call = (adapter, method, argument) => callAdapter(adapter, method, argument, deadline);
  const initialPolicyVersion = policyVersion(policy);
  if (policy.dataPolicy.mode === 'disallow-model-calls') {
    refuse('MODEL_CALLS_DISABLED', 'The policy disables model calls.');
  }
  const adapters = selectModelAdapters(policy, { modelAdapter, modelAdapters });
  if (policy.dataPolicy.roleRoutes === undefined) {
    if (!policy.dataPolicy.selectedProvider
      || !policy.dataPolicy.allowedProviders.includes(policy.dataPolicy.selectedProvider)) {
      refuse('PROVIDER_NOT_ALLOWED', 'Select an allowlisted provider before model review.');
    }
  } else if (policy.dataPolicy.selectedProvider !== undefined
    || Object.keys(policy.dataPolicy.roleRoutes).length !== policy.reviewers.length
    || policy.reviewers.some((role) => !Object.hasOwn(policy.dataPolicy.roleRoutes, role)
      || !policy.dataPolicy.allowedProviders.includes(policy.dataPolicy.roleRoutes[role].providerId))) {
    refuse('PROVIDER_NOT_ALLOWED', 'Select an allowlisted provider route for every reviewer.');
  }
  assertReviewBundle(bundle);
  if (bundle.mode !== policy.mode || bundle.reviewers.length !== policy.reviewers.length
    || policy.reviewers.some((role) => !bundle.reviewers.includes(role))
    || !Object.isFrozen(bundle) || !Object.isFrozen(bundle.files)
    || bundle.files.some((file) => !Object.isFrozen(file))) {
    refuse('INVALID_BUNDLE', 'The captured bundle must be frozen and match the selected review policy.');
  }
  requirePrompts(prompts, policy.reviewers);
  if (typeof harnessAdapter?.assertScope === 'function') {
    await call(harnessAdapter, 'assertScope', {
      policyVersion: initialPolicyVersion, reviewId: bundle.reviewId,
      snapshotSha256: bundle.snapshot.sha256, mode: bundle.mode,
      reviewers: [...bundle.reviewers],
    });
  }
  const declaredHarness = await call(harnessAdapter, 'getCapabilities');
  const activeHarness = await call(harnessAdapter, 'verifyRuntime');
  verifyRuntime(declaredHarness, activeHarness);
  const activeModels = {};
  for (const role of policy.reviewers) {
    const declared = await call(adapters[role], 'getCapabilities');
    const active = await call(adapters[role], 'verifyRuntime');
    verifyRuntime(declared, active);
    activeModels[role] = active;
  }
  // Refuse forbidden providers and missing controls before giving any prompt
  // text to the model adapter. Actual counts are checked again below.
  assertRoutedModelPreflight(policy, {
    harness: activeHarness, models: activeModels,
    inputTokenBounds: Object.fromEntries(policy.reviewers.map((role) => [role, 0])),
  });

  const requests = [];
  const inputTokenBounds = {};
  for (const role of policy.reviewers) {
    const activeModel = activeModels[role];
    const payload = await call(adapters[role], 'prepareRequest', {
      role, prompt: prompts[role], snapshotSha256: bundle.snapshot.sha256,
      providerId: activeModel.providerId, modelId: activeModel.modelId,
      maxOutputTokens: policy.budgets.maxOutputTokensPerReviewer,
    });
    if (typeof payload !== 'string' || payload.length === 0) {
      refuse('ADAPTER_FAILED', 'A model adapter did not return an exact serialized request.');
    }
    const count = await call(adapters[role], 'countInputTokens', {
      role, payload, modelId: activeModel.modelId,
    });
    if (!count || count.conservative !== true || !Number.isSafeInteger(count.upperBound)
      || count.upperBound < 0) {
      refuse('TOKEN_BOUNDS_UNAVAILABLE', 'The model adapter did not provide a conservative token bound.');
    }
    inputTokenBounds[role] = count.upperBound;
    requests.push(Object.freeze({ role, payload,
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      inputTokenUpperBound: count.upperBound }));
  }
  const readiness = assertRoutedModelPreflight(policy, {
    harness: activeHarness, models: activeModels, inputTokenBounds,
  });
  if (policyVersion(policy) !== initialPolicyVersion) {
    refuse('POLICY_CHANGED', 'The review policy changed during request preparation.');
  }
  return Object.freeze({
    reviewId: bundle.reviewId,
    snapshotSha256: bundle.snapshot.sha256,
    policyVersion: initialPolicyVersion,
    preflightDeadline: deadline,
    harnessAdapterId: activeHarness.adapterId,
    harnessAdapterVersion: activeHarness.adapterVersion,
    modelAdapterId: activeModels[policy.reviewers[0]].adapterId,
    modelAdapterVersion: activeModels[policy.reviewers[0]].adapterVersion,
    readiness,
    runtimeControls: Object.freeze({
      harness: Object.freeze({ ...activeHarness.controls }),
      models: Object.freeze(Object.fromEntries(policy.reviewers.map((role) =>
        [role, Object.freeze({ ...activeModels[role].controls })]))),
    }),
    requests: Object.freeze(requests),
  });
}

// Verify effective controls again after payload preparation, immediately
// before dispatch. Adapter claims still require a trusted implementation.
export async function recheckDispatchRuntime(policy, plan, { harnessAdapter, modelAdapter, modelAdapters } = {}) {
  const deadline = plan.preflightDeadline ?? captureDeadline(policy);
  const call = (adapter, method, argument) => callAdapter(adapter, method, argument, deadline);
  if (policyVersion(policy) !== plan.policyVersion) {
    refuse('POLICY_CHANGED', 'The review policy changed before reviewer dispatch.');
  }
  if (typeof harnessAdapter?.assertScope === 'function') {
    await call(harnessAdapter, 'assertScope', {
      policyVersion: plan.policyVersion, reviewId: plan.reviewId,
      snapshotSha256: plan.snapshotSha256, mode: policy.mode,
      reviewers: [...policy.reviewers],
    });
  }
  const adapters = selectModelAdapters(policy, { modelAdapter, modelAdapters });
  const harness = await call(harnessAdapter, 'verifyRuntime');
  const models = {};
  for (const role of policy.reviewers) {
    models[role] = await call(adapters[role], 'verifyRuntime');
  }
  const readiness = assertRoutedModelPreflight(policy, {
    harness, models, inputTokenBounds: plan.readiness.inputTokenBounds,
  });
  if (harness.adapterId !== plan.harnessAdapterId
    || harness.adapterVersion !== plan.harnessAdapterVersion
    || JSON.stringify(readiness.routes) !== JSON.stringify(plan.readiness.routes)) {
    refuse('CAPABILITY_MISMATCH', 'Adapter settings changed before reviewer dispatch.');
  }
}
