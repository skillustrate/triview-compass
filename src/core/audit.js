import { createHash } from 'node:crypto';
import { assertAdapterCapabilities, assertAuditRecord, assertReviewBundle, assertReviewPolicy } from './contracts.js';
import { PreflightError } from './errors.js';

const ROLES = ['code-quality', 'security', 'performance'];
const STATES = ['included', 'excluded', 'binary', 'generated', 'oversized'];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function policyVersion(policy) {
  assertReviewPolicy(policy);
  return createHash('sha256').update(canonical(policy)).digest('hex');
}

function refuse() {
  throw new PreflightError('INVALID_AUDIT', 'Audit metadata is incomplete or inconsistent.');
}

// Only explicitly selected metadata enters this record; source, paths, prompts,
// model outputs, and adapter limitations are never copied into it.
export function createAuditRecord(bundle, policy, {
  event, adapters = [], promptVersions = [], reviewerStatuses,
  findingsCount, validationStatus, sandboxStatus,
  sandboxProfile, sandboxImageSha256, tokenUsage,
} = {}) {
  assertReviewBundle(bundle);
  assertReviewPolicy(policy);
  if (bundle.mode !== policy.mode || ROLES.some((role) => bundle.reviewers.includes(role) !== policy.reviewers.includes(role))
    || !Array.isArray(adapters) || !Array.isArray(reviewerStatuses)
    || reviewerStatuses.length !== ROLES.length || !Array.isArray(promptVersions)) refuse();
  const statuses = new Map();
  for (const item of reviewerStatuses) {
    if (!item || !ROLES.includes(item.role) || statuses.has(item.role)) refuse();
    statuses.set(item.role, item.status);
  }
  for (const role of ROLES) {
    if (!statuses.has(role)
      || (policy.reviewers.includes(role) && statuses.get(role) === 'omitted')
      || (!policy.reviewers.includes(role) && statuses.get(role) !== 'omitted')) refuse();
  }
  if (event === 'review-finished' && (validationStatus !== 'valid'
    || policy.reviewers.some((role) => statuses.get(role) !== 'completed'))) refuse();
  if (policy.sandbox.executionRequested === false && sandboxStatus !== 'not-requested') refuse();
  if (policy.sandbox.executionRequested === true && sandboxStatus === 'not-requested') refuse();
  if (sandboxStatus === 'completed' && (!sandboxProfile || !sandboxImageSha256)) refuse();
  const adapterSummaries = adapters.map((adapter) => {
    assertAdapterCapabilities(adapter);
    return {
      adapterId: adapter.adapterId, adapterType: adapter.adapterType, version: adapter.adapterVersion,
      ...(adapter.providerId ? { providerId: adapter.providerId } : {}),
      ...(adapter.modelId ? { modelId: adapter.modelId } : {}),
    };
  });
  const scopeCounts = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const file of bundle.files) scopeCounts[file.state]++;
  const record = {
    contractVersion: '1.0', reviewId: bundle.reviewId, timestamp: new Date().toISOString(),
    event, snapshotSha256: bundle.snapshot.sha256, policyVersion: policyVersion(policy),
    scopeCounts, adapters: adapterSummaries,
    promptVersions: promptVersions.map((item) => ({ role: item?.role, version: item?.version })),
    reviewerStatuses: reviewerStatuses.map(({ role, status }) => ({ role, status })),
    findingsCount, validationStatus, sandboxStatus,
    ...(sandboxProfile === undefined ? {} : { sandboxProfile }),
    ...(sandboxImageSha256 === undefined ? {} : { sandboxImageSha256 }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
  assertAuditRecord(record);
  return record;
}
