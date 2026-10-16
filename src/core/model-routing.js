import { PreflightError } from './errors.js';

export function selectModelAdapters(policy, { modelAdapter, modelAdapters } = {}) {
  const routed = policy.dataPolicy.roleRoutes !== undefined;
  if (routed) {
    if (modelAdapter !== undefined || !modelAdapters || typeof modelAdapters !== 'object'
      || Array.isArray(modelAdapters)
      || Object.keys(modelAdapters).length !== policy.reviewers.length
      || policy.reviewers.some((role) => !Object.hasOwn(modelAdapters, role))) {
      throw new PreflightError('INVALID_ADAPTER_ROUTE', 'Each reviewer needs one configured model adapter.');
    }
    return Object.freeze({ ...modelAdapters });
  }
  if (modelAdapters !== undefined || !modelAdapter) {
    throw new PreflightError('INVALID_ADAPTER_ROUTE', 'The selected provider needs one model adapter.');
  }
  return Object.freeze(Object.fromEntries(policy.reviewers.map((role) => [role, modelAdapter])));
}
