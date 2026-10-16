import { createStaticReviewHarnessAdapter } from '../adapters/harness/static-review.js';
import { assertSandboxConfiguration } from './sandbox-config.js';
import { createAuditRecord } from './audit.js';
import { appendAuditRecord, assertAuditConfiguration } from './audit-store.js';
import { assertConsolidatedReport, assertReviewPolicy, assertReviewRequest, assertSandboxResult } from './contracts.js';
import { assertSafePreflightReport, refusedPreflight } from './preflight-report.js';
import { PreflightError } from './errors.js';
import { preflightGit } from './git-capture.js';
import { freezeBundle, preflightFiles, sanitizeUntrustedText } from './preflight.js';
import { buildReviewerPrompts } from './prompt-builder.js';
import { runReview } from './review-dispatch.js';

async function verifySandbox({ sandboxAdapter, sandbox, policy, bundle, scan }) {
  if (!sandboxAdapter || typeof sandboxAdapter.runVerification !== 'function') {
    return { status: 'skipped', reason: 'No trusted sandbox adapter was configured.' };
  }
  try {
    const result = JSON.parse(JSON.stringify(await sandboxAdapter.runVerification({ ...sandbox, policy, bundle, scan })));
    assertSandboxResult(result);
    if (result.status === 'not-requested'
      || (result.imageSha256 !== undefined && result.imageSha256 !== sandbox.image.split('@sha256:')[1])) {
      throw new PreflightError('INVALID_SANDBOX_RESULT', 'The sandbox result does not match the requested verification.');
    }
    for (const field of ['stdout', 'stderr', 'reason']) {
      if (result[field] !== undefined) result[field] = sanitizeUntrustedText(result[field], { scan }).content;
    }
    assertSandboxResult(result);
    return result;
  } catch {
    return { status: 'failed', reason: 'Sandbox verification failed or returned invalid output.' };
  }
}

// Application entry point for a report-only review. The caller chooses and
// configures the model/agent adapter; this function never selects a provider.
async function executeReview({ request, policy, repositoryPath, scan,
  modelAdapter, modelAdapters, audit, sandbox, sandboxAdapter, harnessAdapter,
  preflightOnly = false, onPreflight } = {}) {
  assertReviewPolicy(policy);
  assertReviewRequest(request);
  if (audit !== undefined) assertAuditConfiguration(audit);
  policy = freezeBundle(structuredClone(policy));
  if (sandbox !== undefined) {
    assertSandboxConfiguration(sandbox);
    if (!policy.sandbox.executionRequested) {
      throw new PreflightError('INVALID_SANDBOX_CONFIG', 'Sandbox configuration requires execution opt-in in the policy.');
    }
    sandbox = structuredClone(sandbox);
  }
  const bundle = request.input.kind === 'git'
    ? preflightGit(request, policy, { repositoryPath, scan })
    : preflightFiles(request, policy, { scan });
  harnessAdapter ??= createStaticReviewHarnessAdapter({ policy, bundle });
  let sandboxReadiness = { status: 'not-requested' };
  if (policy.sandbox.executionRequested) {
    sandboxReadiness = { status: 'skipped', reason: 'No sandbox image, command, or preflight-capable adapter was configured.' };
    if (sandbox !== undefined && typeof sandboxAdapter?.preflight === 'function') {
      try {
        sandboxReadiness = JSON.parse(JSON.stringify(await sandboxAdapter.preflight({ policy, image: sandbox.image })));
        if (sandboxReadiness.status === 'ready' && (sandboxReadiness.image !== sandbox.image
          || sandboxReadiness.imageSha256 !== sandbox.image.split('@sha256:')[1])) throw new Error('identity');
        if (!['ready', 'skipped'].includes(sandboxReadiness.status)) throw new Error('status');
        if (sandboxReadiness.reason !== undefined) {
          sandboxReadiness.reason = sanitizeUntrustedText(sandboxReadiness.reason, { scan }).content;
        }
      } catch {
        sandboxReadiness = { status: 'skipped', reason: 'Sandbox runtime preflight failed.' };
      }
    }
  }
  let preflight;
  const report = await runReview(policy, bundle, { harnessAdapter, modelAdapter, modelAdapters, preflightOnly,
    onPreflight: async (modelReport) => {
      preflight = { ...modelReport, sandbox: sandboxReadiness,
        audit: { enabled: (audit?.retentionDays ?? 0) > 0, metadataOnly: true, retentionDays: audit?.retentionDays ?? 0 } };
      assertSafePreflightReport(preflight);
      preflight = freezeBundle(preflight);
      if (onPreflight !== undefined) await onPreflight(preflight);
    } });
  if (preflightOnly) return preflight;
  report.preflight = preflight;
  report.sandbox = sandboxReadiness.status === 'ready'
    ? await verifySandbox({ sandboxAdapter, sandbox, policy, bundle, scan }) : sandboxReadiness;
  if (policy.sandbox.executionRequested) {
    report.coverage.skippedChecks = report.coverage.skippedChecks
      .filter((item) => item !== 'Sandbox verification is not implemented.');
    report.limitations.push('Sandbox verification covers only included sanitized non-deleted files, not a complete checkout.');
    if (report.sandbox.status !== 'completed') {
      report.status = 'incomplete';
      report.verdict = 'incomplete';
      report.coverage.skippedChecks.push(`Sandbox verification ${report.sandbox.status}; see the sandbox result for the reason.`);
    }
  }
  assertConsolidatedReport(report);
  if (audit !== undefined) {
    const uniqueAdapters = [...new Set(modelAdapters ? Object.values(modelAdapters) : [modelAdapter])];
    const record = createAuditRecord(bundle, policy, {
      event: report.status === 'incomplete' ? 'review-incomplete' : 'review-finished',
      adapters: [await harnessAdapter.getCapabilities(),
        ...await Promise.all(uniqueAdapters.map((adapter) => adapter.getCapabilities()))],
      promptVersions: buildReviewerPrompts(bundle, policy).promptVersions,
      reviewerStatuses: report.reviewers.map(({ role, status }) => ({ role, status })),
      findingsCount: report.findings.length,
      validationStatus: report.status === 'incomplete' ? 'partial' : 'valid',
      sandboxStatus: report.sandbox.status,
      sandboxProfile: report.sandbox.profile,
      sandboxImageSha256: report.sandbox.imageSha256,
    });
    await appendAuditRecord(record, audit);
  }
  return report;
}

export async function runStaticReview(options = {}) {
  let announced = false;
  try {
    return await executeReview({ ...options, onPreflight: async (report) => {
      announced = true;
      if (options.onPreflight !== undefined) await options.onPreflight(report);
    } });
  } catch (error) {
    if (!announced) {
      const refused = refusedPreflight(error);
      if (options.onPreflight !== undefined) await options.onPreflight(refused);
      if (options.preflightOnly === true) return refused;
    }
    throw error;
  }
}
