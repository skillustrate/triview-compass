import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { assertReviewPolicy, assertReviewRequest } from './contracts.js';
import { captureDeadline, remainingTime } from './deadline.js';
import { PreflightError } from './errors.js';

export { PreflightError } from './errors.js';

const ROLES = ['code-quality', 'security', 'performance'];
const CHANGE_TYPES = new Set(['added', 'modified', 'deleted', 'renamed']);
const SECRET_KINDS = new Set(['credential', 'private-key', 'token', 'personal-data', 'other']);

function refuse(code, message) {
  throw new PreflightError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function updateField(hash, value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function validPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 1024
    && !path.startsWith('/')
    && !path.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function lineCount(content) {
  if (content.length === 0) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function compileGlob(glob) {
  if (typeof glob !== 'string' || !glob || glob.length > 256 || glob.includes('\\') || /[?{}[\]]/u.test(glob)) {
    refuse('INVALID_POLICY', 'A path glob is unsupported.');
  }
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    if (glob.slice(i, i + 3) === '**/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.slice(i, i + 2) === '**') {
      source += '.*';
      i++;
    } else if (glob[i] === '*') {
      source += '[^/]*';
    } else {
      source += glob[i].replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function validatePolicy(policy, deadline) {
  if (!isRecord(policy) || policy.contractVersion !== '1.0' || !isRecord(policy.budgets)
    || !isRecord(policy.pathPolicy) || !isRecord(policy.secretPolicy)) {
    refuse('INVALID_POLICY', 'The policy shape is incomplete.');
  }
  const reviewers = policy.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length === 0 || new Set(reviewers).size !== reviewers.length
    || reviewers.some((role) => !ROLES.includes(role))
    || (policy.mode === 'full' && (reviewers.length !== 3 || ROLES.some((role) => !reviewers.includes(role))))
    || (policy.mode === 'partial' && reviewers.length >= 3)
    || !['full', 'partial'].includes(policy.mode)) {
    refuse('INVALID_POLICY', 'Review mode or reviewer list is invalid.');
  }
  for (const name of ['maxFiles', 'maxChangedLines', 'maxLinesPerFile', 'maxBytesPerFile', 'maxInputTokensPerReviewer',
    'maxOutputTokensPerReviewer', 'maxModelCalls', 'timeoutSeconds']) {
    if (!Number.isSafeInteger(policy.budgets[name]) || policy.budgets[name] < 1) {
      refuse('INVALID_POLICY', 'A budget is missing or invalid.');
    }
  }
  if (policy.budgets.maxBytesPerFile > 8388608) {
    refuse('INVALID_POLICY', 'The file byte limit exceeds the v1 maximum.');
  }
  if (policy.mode === 'full' && policy.budgets.maxModelCalls < 3) {
    refuse('INVALID_POLICY', 'A full review needs three model calls.');
  }
  for (const name of ['excludedPathGlobs', 'generatedPathGlobs']) {
    if (!Array.isArray(policy.pathPolicy[name])) refuse('INVALID_POLICY', 'Path patterns are missing.');
  }
  if (!Array.isArray(policy.secretPolicy.sensitivePathGlobs)
    || policy.secretPolicy.scannerRequired !== true
    || policy.secretPolicy.onScannerFailure !== 'stop-review'
    || policy.pathPolicy.symlinkHandling !== 'reject') {
    refuse('UNSUPPORTED_POLICY', 'The selected path or scanner mode is not implemented.');
  }
  remainingTime(deadline, 'CAPTURE_TIMEOUT');
  return {
    excluded: policy.pathPolicy.excludedPathGlobs.map(compileGlob),
    generated: policy.pathPolicy.generatedPathGlobs.map(compileGlob),
    sensitive: policy.secretPolicy.sensitivePathGlobs.map(compileGlob),
  };
}

function validateFiles(request, policy, deadline) {
  if (!isRecord(request) || request.contractVersion !== '1.0' || !isRecord(request.input)) {
    refuse('INVALID_INPUT', 'The request shape is incomplete.');
  }
  if (request.input.kind !== 'files') {
    refuse('UNSUPPORTED_INPUT', 'This preflight slice accepts explicit file input only.');
  }
  const files = request.input.files;
  if (!Array.isArray(files) || files.length === 0) refuse('INVALID_INPUT', 'No files were supplied.');
  if (files.length > policy.budgets.maxFiles) refuse('BUDGET_EXCEEDED', 'File count exceeds the configured limit; split the change.');
  const seen = new Set();
  let totalLines = 0;
  for (const entry of files) {
    remainingTime(deadline, 'CAPTURE_TIMEOUT');
    if (!isRecord(entry) || !validPath(entry.path) || !CHANGE_TYPES.has(entry.changeType)
      || typeof entry.content !== 'string' || (entry.changeType === 'renamed') !== ('previousPath' in entry)
      || ('previousPath' in entry && !validPath(entry.previousPath))) {
      refuse('INVALID_INPUT', 'A file entry is invalid.');
    }
    const key = entry.path.toLowerCase();
    if (seen.has(key)) refuse('INVALID_INPUT', 'Duplicate or case-colliding paths were supplied.');
    seen.add(key);
    if (Buffer.byteLength(entry.content, 'utf8') > policy.budgets.maxBytesPerFile) {
      refuse('BUDGET_EXCEEDED', 'A changed file exceeds the configured byte limit.');
    }
    const lines = lineCount(entry.content);
    totalLines += lines;
    if (lines > policy.budgets.maxLinesPerFile || totalLines > policy.budgets.maxChangedLines) {
      refuse('BUDGET_EXCEEDED', 'Changed-line limit exceeded; split the change.');
    }
  }
  return files;
}

export function scanSecrets(content) {
  const patterns = [
    { kind: 'private-key', regex: /-----BEGIN ((?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu },
    { kind: 'credential', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
    { kind: 'credential', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu },
    { kind: 'credential', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
    { kind: 'credential', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu },
    { kind: 'credential', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
    { kind: 'credential', regex: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
    { kind: 'credential', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/gu },
    { kind: 'token', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  ];
  const spans = [];
  for (const { kind, regex } of patterns) {
    for (const match of content.matchAll(regex)) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  // Bearer headers can contain otherwise unrecognized opaque tokens. Prefer a
  // more specific provider match when both patterns identify the same value.
  const bearer = /\bBearer[ \t]+([A-Za-z0-9._~+/-]{20,}={0,2})(?![A-Za-z0-9._~+/-])/giu;
  for (const match of content.matchAll(bearer)) {
    const start = match.index + match[0].lastIndexOf(match[1]);
    const end = start + match[1].length;
    if (!spans.some((span) => start < span.end && end > span.start)) {
      spans.push({ start, end, kind: 'token' });
    }
  }
  // HTTP Basic-auth payloads: the base64 credential pair after "Basic ".
  const basicAuth = /\bBasic[ \t]+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gdu;
  for (const match of content.matchAll(basicAuth)) {
    const [start, end] = match.indices[1];
    if (!spans.some((span) => start < span.end && end > span.start)) {
      spans.push({ start, end, kind: 'credential' });
    }
  }
  // Secrets passed as URL query-string parameters (common credential-looking
  // key names). Obvious placeholders (YOUR_TOKEN, xxxx, <TOKEN>, ...) are
  // excluded so documentation examples do not trip the scanner.
  const placeholder = /^(?:x+|\*+|\.{3,}|none|null|undefined|redacted|placeholder|example|changeme|change_me|test|sample|todo|your[-_]?\w*|<[^>]*>)$/iu;
  const queryParam = /[?&](?:access[-_]?token|api[-_]?key|apikey|auth[-_]?token|client[-_]?secret|session[-_]?token|secret|token|password|passwd|pwd)=([^&#\s"'<>{}$]{8,})/gidu;
  for (const match of content.matchAll(queryParam)) {
    if (placeholder.test(match[1])) continue;
    const [start, end] = match.indices[1];
    if (!spans.some((span) => start < span.end && end > span.start)) {
      spans.push({ start, end, kind: 'credential' });
    }
  }
  return spans;
}

function timedScan(scanner, content, deadline) {
  return runInNewContext('scanner(content)', { scanner, content },
    { timeout: remainingTime(deadline, 'SCANNER_TIMEOUT') });
}

function redact(content, scan, deadline) {
  let spans;
  try {
    spans = timedScan(scanSecrets, content, deadline);
    if (scan !== undefined) {
      const extra = timedScan(scan, content, deadline);
      if (!Array.isArray(extra)) throw new Error('invalid scanner result');
      spans.push(...extra);
    }
    spans = [...spans].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const span of spans) {
      if (!isRecord(span) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || span.start < cursor || span.end <= span.start || span.end > content.length
        || !SECRET_KINDS.has(span.kind)) throw new Error('invalid scanner span');
      cursor = span.end;
    }
    remainingTime(deadline, 'SCANNER_TIMEOUT');
  } catch (error) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || error?.code === 'SCANNER_TIMEOUT') {
      refuse('SCANNER_TIMEOUT', 'Local secret scanning exceeded its time limit.');
    }
    refuse('SCANNER_FAILED', 'Local secret scanning failed.');
  }
  let output = '';
  let cursor = 0;
  const counts = new Map();
  for (const span of spans) {
    output += content.slice(cursor, span.start) + `[REDACTED: ${span.kind}]`;
    counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
    cursor = span.end;
  }
  output += content.slice(cursor);
  return { content: output, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

export function sanitizeUntrustedText(content, { scan, timeoutMs = 5000 } = {}) {
  if (typeof content !== 'string') refuse('SCANNER_FAILED', 'Local secret scanning failed.');
  return redact(content, scan, Date.now() + timeoutMs);
}

function snapshotHash(files, deadline) {
  const hash = createHash('sha256');
  for (const value of ['triview-compass-snapshot-v1', 'files']) updateField(hash, value);
  for (const entry of files) {
    remainingTime(deadline, 'CAPTURE_TIMEOUT');
    for (const value of [entry.path, entry.changeType, entry.previousPath ?? '', sha256(entry.content)]) {
      updateField(hash, value);
    }
  }
  return hash.digest('hex');
}

export function freezeBundle(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeBundle(nested);
    Object.freeze(value);
  }
  return value;
}

export function preflightFiles(request, policy, { scan, deadline } = {}) {
  assertReviewPolicy(policy);
  assertReviewRequest(request);
  const captureEnd = Math.min(captureDeadline(policy), deadline ?? Infinity);
  const globs = validatePolicy(policy, captureEnd);
  remainingTime(captureEnd, 'CAPTURE_TIMEOUT');
  const files = validateFiles(request, policy, captureEnd)
    .slice()
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const sha = snapshotHash(files, captureEnd);
  const classified = files.map((entry) => {
    remainingTime(captureEnd, 'CAPTURE_TIMEOUT');
    const base = { path: entry.path, changeType: entry.changeType };
    if (entry.previousPath) base.previousPath = entry.previousPath;
    const paths = entry.previousPath ? [entry.path, entry.previousPath] : [entry.path];
    const state = globs.sensitive.some((glob) => paths.some((path) => glob.test(path)))
      || globs.excluded.some((glob) => paths.some((path) => glob.test(path))) ? 'excluded'
      : globs.generated.some((glob) => glob.test(entry.path)) ? 'generated' : 'included';
    if (state !== 'included') return { ...base, state, exclusionReason: `${state} by path policy` };
    const sanitized = redact(entry.content, scan, captureEnd);
    return { ...base, state, content: sanitized.content,
      contentSha256: sha256(sanitized.content), redactions: sanitized.redactions };
  });
  remainingTime(captureEnd, 'CAPTURE_TIMEOUT');
  return freezeBundle({
    contractVersion: '1.0',
    reviewId: `review-${sha.slice(0, 20)}`,
    snapshot: { sha256: sha, capturedAt: new Date().toISOString(), inputKind: 'files' },
    mode: policy.mode,
    reviewers: [...policy.reviewers],
    files: classified,
  });
}
