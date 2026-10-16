import { createHash, randomUUID } from 'node:crypto';
import { recheckDispatchRuntime } from './adapter-handshake.js';
import { assertConsolidatedReport, assertReviewerResult } from './contracts.js';
import { PreflightError } from './errors.js';
import { selectModelAdapters } from './model-routing.js';
import { prepareReviewInputs } from './prepare-review.js';
import { REQUIRED_SKILLS } from './prompt-builder.js';
import { createPreflightReport } from './preflight-report.js';
import { scanSecrets } from './preflight.js';

const ROLES = ['code-quality', 'security', 'performance'];
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(reason) {
  return { status: 'failed', reason };
}

function lineCount(content) {
  if (content.length === 0) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function containsKnownSecret(value) {
  if (typeof value === 'string') return scanSecrets(value).length > 0;
  if (Array.isArray(value)) return value.some(containsKnownSecret);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsKnownSecret);
  return false;
}

function checkEvidence(finding, bundle, resolveFileId) {
  const resolved = resolveFileId(finding.evidence.path);
  if (!resolved) return { reason: 'unknown-file-id' };
  const file = bundle.files.find((item) => item.path === resolved.path && item.state === 'included');
  if (!file) return { reason: 'unknown-file-id' };
  if (finding.evidence.diffHunk !== undefined) return { reason: 'unverified-hunk' };
  const { startLine, endLine } = finding.evidence;
  if (startLine > endLine || endLine > lineCount(file.content)) return { reason: 'invalid-line-range' };
  return { evidence: { path: resolved.path, startLine, endLine } };
}

function duplicateKey(finding) {
  return JSON.stringify([finding.category, finding.title, finding.impact,
    finding.recommendation ?? '', finding.evidence]);
}

function consolidate(validFindings) {
  const groups = new Map();
  for (const { reviewer, finding } of validFindings) {
    const key = duplicateKey(finding);
    let group = groups.get(key);
    if (!group) {
      group = { id: `finding-${groups.size + 1}`, category: finding.category,
        severity: finding.severity, title: finding.title, impact: finding.impact,
        evidence: finding.evidence,
        ...(finding.recommendation === undefined ? {} : { recommendation: finding.recommendation }),
        sourceFindings: [], disagreement: false };
      groups.set(key, group);
    }
    if (group.severity !== finding.severity) {
      group.disagreement = true;
      const order = ['Nit', 'Optional', 'Required', 'Critical'];
      if (order.indexOf(finding.severity) > order.indexOf(group.severity)) group.severity = finding.severity;
    }
    group.sourceFindings.push({ reviewer, findingId: finding.id,
      severity: finding.severity, confidence: finding.confidence });
  }
  return [...groups.values()];
}

function report(policy, bundle, plan, outcomes) {
  const reviewers = [];
  const validFindings = [];
  const unverifiableFindings = [];
  const limitations = [...plan.readiness.limitations];
  for (const role of ROLES) {
    if (!policy.reviewers.includes(role)) {
      reviewers.push({ role, status: 'omitted', reason: 'Omitted by explicit partial-review policy.' });
      continue;
    }
    const outcome = outcomes.get(role);
    const route = plan.readiness.routes[role];
    const adapter = { adapterId: route.adapterId, providerId: route.providerId, modelId: route.modelId };
    if (outcome.status === 'failed') {
      reviewers.push({ role, status: 'failed', adapter, reason: outcome.reason,
        ...(outcome.invocationId ? { invocationId: outcome.invocationId } : {}) });
      limitations.push(`${role}: ${outcome.reason}`);
      continue;
    }
    const { result } = outcome;
    let unverifiable = false;
    const seenIds = new Set();
    for (const finding of result.findings) {
      let checked;
      if (seenIds.has(finding.id)) checked = { reason: 'duplicate-finding-id' };
      else if (!REQUIRED_SKILLS[role].includes(finding.skill)) checked = { reason: 'invalid-skill' };
      else checked = checkEvidence(finding, bundle, plan.resolveFileId);
      seenIds.add(finding.id);
      if (checked.reason) {
        unverifiable = true;
        unverifiableFindings.push({ reviewer: role, findingId: finding.id,
          title: finding.title, severity: finding.severity, reason: checked.reason });
      } else {
        validFindings.push({ reviewer: role, finding: { ...finding, evidence: checked.evidence } });
      }
    }
    if (unverifiable) {
      reviewers.push({ role, status: 'failed', adapter, invocationId: result.invocationId,
        contextId: result.contextId, reason: 'One or more findings could not be verified.' });
      limitations.push(`${role}: ${unverifiableFindings.filter((item) => item.reviewer === role).length} finding(s) could not be verified.`);
    } else {
      reviewers.push({ role, status: 'completed', adapter, invocationId: result.invocationId,
        contextId: result.contextId });
    }
  }
  const findings = consolidate(validFindings);
  const allSelectedComplete = policy.reviewers.every((role) => reviewers.find((item) => item.role === role).status === 'completed');
  const status = !allSelectedComplete ? 'incomplete' : policy.mode === 'full' ? 'complete' : 'partial';
  const required = findings.some((item) => ['Critical', 'Required'].includes(item.severity));
  const requestedChanges = policy.reviewers.some((role) => outcomes.get(role)?.result?.verdict === 'request-changes');
  const verdict = status === 'incomplete' ? 'incomplete' : required || requestedChanges ? 'request-changes' : 'recommend-approval';
  const coverage = {
    includedPaths: bundle.files.filter((item) => item.state === 'included').map((item) => item.path),
    excludedPaths: bundle.files.filter((item) => item.state !== 'included').map((item) => item.path),
    skippedChecks: [
      ...new Set(bundle.files.filter((item) => item.state !== 'included')
        .map((item) => `${item.state} content was omitted from reviewer input.`)),
      ...(policy.sandbox.executionRequested ? ['Sandbox verification is not implemented.'] : ['Sandbox verification was not requested.']),
    ],
  };
  const consolidated = { contractVersion: '1.0', reviewId: bundle.reviewId,
    snapshotSha256: bundle.snapshot.sha256, mode: policy.mode, status, verdict,
    reviewers, findings, unverifiableFindings, coverage, limitations };
  assertConsolidatedReport(consolidated);
  return consolidated;
}

async function invoke(modelAdapter, request, policy, bundle, plan) {
  const invocationId = `invocation-${randomUUID()}`;
  const abortController = new AbortController();
  let timer;
  try {
    if (!modelAdapter || typeof modelAdapter.invokeReview !== 'function') {
      return fail('The model adapter cannot start a reviewer session.');
    }
    if (sha256(request.payload) !== request.payloadSha256) {
      return fail('The prepared request changed before dispatch.');
    }
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new PreflightError('REVIEWER_TIMEOUT', 'A reviewer exceeded its time limit.'));
      }, Math.min(policy.budgets.timeoutSeconds * 1000, 2147483647));
    });
    const response = await Promise.race([Promise.resolve().then(() => modelAdapter.invokeReview({
      role: request.role, invocationId, payload: request.payload,
      payloadSha256: request.payloadSha256, inputTokenUpperBound: request.inputTokenUpperBound,
      maxOutputTokens: policy.budgets.maxOutputTokensPerReviewer,
      freshContext: true, memoryEnabled: false, tools: Object.freeze([]),
      signal: abortController.signal,
    })), timeout]);
    let serialized;
    try {
      serialized = JSON.stringify(response);
    } catch {
      return { ...fail('The reviewer returned invalid output.'), invocationId };
    }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
      return { ...fail('The reviewer returned unsafe or oversized output.'), invocationId };
    }
    // Parse a detached data copy so an adapter cannot mutate validated fields
    // after this check. Scan the original string fields, including newlines.
    const parsed = JSON.parse(serialized);
    if (containsKnownSecret(parsed)) {
      return { ...fail('The reviewer returned unsafe or oversized output.'), invocationId };
    }
    try {
      assertReviewerResult(parsed);
    } catch {
      return { ...fail('The reviewer result does not satisfy its contract.'), invocationId };
    }
    const version = plan.promptVersions.find((item) => item.role === request.role)?.version;
    const route = plan.readiness.routes[request.role];
    const expected = REQUIRED_SKILLS[request.role];
    if (parsed.reviewId !== bundle.reviewId || parsed.snapshotSha256 !== bundle.snapshot.sha256
      || parsed.invocationId !== invocationId || parsed.reviewer !== request.role
      || parsed.adapter.adapterId !== route.adapterId
      || parsed.adapter.providerId !== route.providerId
      || parsed.adapter.modelId !== route.modelId
      || parsed.promptVersion !== version
      || parsed.skills.length !== expected.length || expected.some((skill) => !parsed.skills.includes(skill))) {
      return { ...fail('The reviewer result does not match its invocation.'), invocationId };
    }
    if (parsed.status !== 'completed') {
      return { ...fail('The reviewer did not complete.'), invocationId };
    }
    return { status: 'completed', result: parsed };
  } catch (error) {
    return { ...fail(error?.code === 'REVIEWER_TIMEOUT'
      ? 'The reviewer exceeded its time limit.' : 'The reviewer invocation failed.'), invocationId };
  } finally {
    clearTimeout(timer);
  }
}

// The model adapter is trusted to create a fresh provider session for each
// invocation and honor the abort signal. Runtime declarations are checked by
// prepareReviewInputs; distinct returned context IDs are checked below.
export async function runReview(policy, bundle, { harnessAdapter, modelAdapter, modelAdapters,
  preflightOnly = false, onPreflight } = {}) {
  const adapters = selectModelAdapters(policy, { modelAdapter, modelAdapters });
  const plan = await prepareReviewInputs(policy, bundle, { harnessAdapter, modelAdapter, modelAdapters });
  await recheckDispatchRuntime(policy, plan, { harnessAdapter, modelAdapter, modelAdapters });
  const preflight = createPreflightReport(policy, bundle, plan);
  if (onPreflight !== undefined) await onPreflight(preflight);
  if (preflightOnly) return preflight;
  if (onPreflight !== undefined) await recheckDispatchRuntime(policy, plan, { harnessAdapter, modelAdapter, modelAdapters });
  const outcomes = new Map(await Promise.all(plan.requests.map(async (request) => [request.role,
    await invoke(adapters[request.role], request, policy, bundle, plan)])));
  const contexts = new Map();
  for (const [role, outcome] of outcomes) {
    if (outcome.status !== 'completed') continue;
    const route = plan.readiness.routes[role];
    const context = JSON.stringify([route.adapterId, route.providerId, outcome.result.contextId]);
    contexts.set(context, [...(contexts.get(context) ?? []), role]);
  }
  for (const roles of contexts.values()) {
    if (roles.length < 2) continue;
    for (const role of roles) {
      outcomes.set(role, { ...fail('Reviewers shared a provider context.'),
        invocationId: outcomes.get(role).result.invocationId });
    }
  }
  return report(policy, bundle, plan, outcomes);
}
