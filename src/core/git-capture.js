import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { assertReviewPolicy, assertReviewRequest } from './contracts.js';
import { captureDeadline, remainingTime } from './deadline.js';
import { PreflightError, freezeBundle, preflightFiles } from './preflight.js';

const COMMIT_ID = /^[a-f0-9]{40}$/u;
const OBJECT_ID = /^[a-f0-9]{40}$/u;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function refuse(code, message) {
  throw new PreflightError(code, message);
}

function git(repo, args, deadline, allowedStatuses = [0]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  const result = spawnSync('git', ['-C', repo, ...args], {
    env,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: remainingTime(deadline, 'CAPTURE_TIMEOUT'),
    killSignal: 'SIGKILL',
    shell: false,
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    refuse('CAPTURE_TIMEOUT', 'Git capture exceeded its time limit.');
  }
  remainingTime(deadline, 'CAPTURE_TIMEOUT');
  if (result.error || !allowedStatuses.includes(result.status)) {
    refuse('GIT_CAPTURE_FAILED', 'Git could not capture the requested committed objects.');
  }
  return result;
}

function readField(bytes, cursor) {
  const end = bytes.indexOf(0, cursor);
  if (end < 0) refuse('GIT_CAPTURE_FAILED', 'Git returned an invalid record.');
  let text;
  try {
    text = decoder.decode(bytes.subarray(cursor, end));
  } catch {
    refuse('INVALID_INPUT', 'A Git path is not valid UTF-8.');
  }
  return [text, end + 1];
}

function parseRaw(bytes, deadline) {
  const records = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    remainingTime(deadline, 'CAPTURE_TIMEOUT');
    let header;
    [header, cursor] = readField(bytes, cursor);
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])(?:\d+)?$/u.exec(header);
    if (!match) refuse('GIT_CAPTURE_FAILED', 'Git returned an unsupported change record.');
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    let path;
    [path, cursor] = readField(bytes, cursor);
    let previousPath;
    if (status === 'R') {
      previousPath = path;
      [path, cursor] = readField(bytes, cursor);
    } else if (!['A', 'M', 'D'].includes(status)) {
      refuse('UNSUPPORTED_FILE', 'A changed Git object type is not supported.');
    }
    const mode = status === 'D' ? oldMode : newMode;
    if (!['100644', '100755'].includes(mode)) {
      refuse('UNSUPPORTED_FILE', 'Symlinks, submodules, and special file modes are not supported.');
    }
    const oid = status === 'D' ? oldOid : newOid;
    if (!OBJECT_ID.test(oid) || /^0+$/u.test(oid)) {
      refuse('GIT_CAPTURE_FAILED', 'Git returned an invalid blob identifier.');
    }
    records.push({
      path,
      oldOid, newOid,
      previousPath,
      changeType: { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }[status],
      oid,
    });
  }
  return records;
}

// Retain only numeric hunk coordinates. Patch text and headers may contain
// sensitive source or paths and must never enter the sanitized bundle.
function changeContext(repo, record, file, deadline) {
  const basis = record.changeType === 'deleted' ? 'base' : 'target';
  if (file.redactions?.length) return { status: 'unavailable', basis, hunks: [] };
  const count = file.content.length === 0 ? 0
    : file.content.split('\n').length - (file.content.endsWith('\n') ? 1 : 0);
  let hunks;
  if (record.changeType === 'added' || record.changeType === 'deleted') {
    hunks = count === 0 ? [] : [{ baseStart: basis === 'base' ? 1 : 0,
      baseCount: basis === 'base' ? count : 0, targetStart: basis === 'target' ? 1 : 0,
      targetCount: basis === 'target' ? count : 0 }];
  } else {
    const patch = git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0',
      '--diff-algorithm=myers', record.oldOid, record.newOid], deadline).stdout.toString('utf8');
    hunks = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)]
      .map((match) => ({ baseStart: Number(match[1]), baseCount: Number(match[2] ?? 1),
        targetStart: Number(match[3]), targetCount: Number(match[4] ?? 1) }));
    if (hunks.some((hunk) => Object.values(hunk).some((value) => !Number.isSafeInteger(value)))) {
      refuse('GIT_CAPTURE_FAILED', 'Git returned invalid change coordinates.');
    }
  }
  return { status: 'available', basis, hunks };
}

function parseNumstat(bytes, deadline) {
  const stats = new Map();
  let cursor = 0;
  while (cursor < bytes.length) {
    remainingTime(deadline, 'CAPTURE_TIMEOUT');
    const firstTab = bytes.indexOf(9, cursor);
    const secondTab = bytes.indexOf(9, firstTab + 1);
    const pathEnd = bytes.indexOf(0, secondTab + 1);
    if (firstTab < 0 || secondTab < 0 || pathEnd < 0) {
      refuse('GIT_CAPTURE_FAILED', 'Git returned an invalid line-count record.');
    }
    const added = bytes.toString('ascii', cursor, firstTab);
    const removed = bytes.toString('ascii', firstTab + 1, secondTab);
    let path;
    try {
      path = decoder.decode(bytes.subarray(secondTab + 1, pathEnd));
    } catch {
      refuse('INVALID_INPUT', 'A Git path is not valid UTF-8.');
    }
    cursor = pathEnd + 1;
    if (path === '') {
      [, cursor] = readField(bytes, cursor);
      [path, cursor] = readField(bytes, cursor);
    }
    const binary = added === '-' && removed === '-';
    if (!binary && (!/^\d+$/u.test(added) || !/^\d+$/u.test(removed))) {
      refuse('GIT_CAPTURE_FAILED', 'Git returned an invalid changed-line count.');
    }
    const lines = binary ? 0 : Number(added) + Number(removed);
    if (!Number.isSafeInteger(lines) || stats.has(path)) {
      refuse('GIT_CAPTURE_FAILED', 'Git returned duplicate or oversized line counts.');
    }
    stats.set(path, { lines, binary });
  }
  return stats;
}

function snapshotHash(base, target, records, deadline) {
  const hash = createHash('sha256');
  const fields = ['triview-compass-snapshot-v1', 'git', base, target];
  for (const record of [...records].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    fields.push(record.path, record.changeType, record.previousPath ?? '', record.contentSha256);
  }
  for (const value of fields) {
    remainingTime(deadline, 'CAPTURE_TIMEOUT');
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

export function preflightGit(request, policy, { repositoryPath, scan } = {}) {
  assertReviewPolicy(policy);
  assertReviewRequest(request);
  const deadline = captureDeadline(policy);
  if (!request || request.contractVersion !== '1.0' || !request.input
    || request.input.kind !== 'git' || !COMMIT_ID.test(request.input.baseRevision)
    || !COMMIT_ID.test(request.input.targetRevision) || !isAbsolute(repositoryPath ?? '')) {
    refuse('INVALID_INPUT', 'A Git request needs two full commit IDs and a trusted absolute repository path.');
  }
  const { baseRevision: base, targetRevision: target } = request.input;
  if (base === target) refuse('INVALID_REVISION', 'Base and target commits must differ.');
  for (const oid of [base, target]) {
    const type = git(repositoryPath, ['cat-file', '-t', oid], deadline).stdout.toString('ascii').trim();
    if (type !== 'commit') refuse('INVALID_REVISION', 'A requested revision is not a commit.');
  }
  const ancestry = git(repositoryPath, ['merge-base', '--is-ancestor', base, target], deadline, [0, 1]);
  if (ancestry.status !== 0) refuse('INVALID_REVISION', 'The base is not an ancestor of the target.');
  const raw = git(repositoryPath, ['diff-tree', '--raw', '-r', '-z', '--no-commit-id', '-M', '--no-ext-diff', '--no-textconv', base, target], deadline).stdout;
  const records = parseRaw(raw, deadline);
  if (records.length === 0) refuse('INVALID_INPUT', 'The requested commits contain no changed files.');
  const numstat = git(repositoryPath, ['diff-tree', '--numstat', '-r', '-z', '--no-commit-id', '-M', '--no-ext-diff', '--no-textconv', base, target], deadline).stdout;
  const stats = parseNumstat(numstat, deadline);
  if (stats.size !== records.length) refuse('GIT_CAPTURE_FAILED', 'Git change metadata does not agree.');
  if (records.length > policy?.budgets?.maxFiles) {
    refuse('BUDGET_EXCEEDED', 'File count exceeds the configured limit; split the change.');
  }
  let totalLines = 0;
  const files = [];
  const binaryPaths = new Set();
  for (const record of records) {
    remainingTime(deadline, 'CAPTURE_TIMEOUT');
    const stat = stats.get(record.path);
    if (!stat) refuse('GIT_CAPTURE_FAILED', 'Git change metadata does not agree.');
    totalLines += stat.lines;
    if (stat.lines > policy?.budgets?.maxLinesPerFile || totalLines > policy?.budgets?.maxChangedLines) {
      refuse('BUDGET_EXCEEDED', 'Changed-line limit exceeded; split the change.');
    }
    const sizeText = git(repositoryPath, ['cat-file', '-s', record.oid], deadline).stdout.toString('ascii').trim();
    if (!/^\d+$/u.test(sizeText) || !Number.isSafeInteger(Number(sizeText))) {
      refuse('GIT_CAPTURE_FAILED', 'Git returned an invalid blob size.');
    }
    if (Number(sizeText) > policy?.budgets?.maxBytesPerFile || Number(sizeText) > 8388608) {
      refuse('BUDGET_EXCEEDED', 'A changed file exceeds the configured byte limit.');
    }
    const bytes = git(repositoryPath, ['cat-file', 'blob', record.oid], deadline).stdout;
    record.contentSha256 = createHash('sha256').update(bytes).digest('hex');
    let content = '';
    let binary = stat.binary || bytes.includes(0);
    if (!binary) {
      try {
        content = decoder.decode(bytes);
      } catch {
        binary = true;
      }
    }
    if (binary) {
      if (policy?.pathPolicy?.binaryHandling === 'stop-review') {
        refuse('UNSUPPORTED_FILE', 'A changed binary file is not allowed by policy.');
      }
      if (policy?.pathPolicy?.binaryHandling !== 'report-and-skip') {
        refuse('INVALID_POLICY', 'Binary handling policy is invalid.');
      }
      binaryPaths.add(record.path);
    }
    files.push({ path: record.path, changeType: record.changeType,
      ...(record.previousPath ? { previousPath: record.previousPath } : {}), content });
  }
  // The file preflight validates paths, roles, and scanner behavior. Git line counts
  // were checked above, so full captured file content does not consume changed-line limits.
  const capturePolicy = structuredClone(policy);
  capturePolicy.budgets.maxChangedLines = Number.MAX_SAFE_INTEGER;
  capturePolicy.budgets.maxLinesPerFile = Number.MAX_SAFE_INTEGER;
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files } }, capturePolicy, { scan, deadline });
  const classified = bundle.files.map((entry) => {
    if (entry.state === 'included' && binaryPaths.has(entry.path)) return { path: entry.path, changeType: entry.changeType,
      ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      state: 'binary', exclusionReason: 'binary content skipped by policy' };
    if (entry.state !== 'included') return entry;
    const record = records.find((item) => item.path === entry.path);
    return { ...entry, changeContext: changeContext(repositoryPath, record, entry, deadline) };
  });
  const sha = snapshotHash(base, target, records, deadline);
  remainingTime(deadline, 'CAPTURE_TIMEOUT');
  return freezeBundle({ ...bundle, files: classified,
    reviewId: `review-${sha.slice(0, 20)}`,
    snapshot: { sha256: sha, capturedAt: bundle.snapshot.capturedAt,
      inputKind: 'git', baseRevision: base, targetRevision: target } });
}
