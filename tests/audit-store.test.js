import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendAuditRecord, pruneAuditRecords } from '../src/core/audit-store.js';
import { createAuditRecord } from '../src/core/audit.js';
import { preflightFiles } from '../src/core/preflight.js';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url)));
const secret = 'AKIAABCDEFGHIJKLMNOP';
const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'src/private.js', changeType: 'added', content: `const key = '${secret}';\n` },
] } }, policy);
const record = createAuditRecord(bundle, policy, { event: 'review-finished',
  reviewerStatuses: policy.reviewers.map((role) => ({ role, status: 'completed' })),
  findingsCount: 0, validationStatus: 'valid', sandboxStatus: 'not-requested' });

test('audit storage writes private metadata and prunes only expired valid audit records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triview-audit-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true }); });
  const pathname = await appendAuditRecord(record, { directory, retentionDays: 30 });
  assert.equal((await stat(pathname)).mode & 0o777, 0o600);
  const contents = await readFile(pathname, 'utf8');
  assert.equal(contents.includes(secret), false);
  assert.equal(contents.includes('src/private.js'), false);
  assert.deepEqual(JSON.parse(contents), record);
  await writeFile(join(directory, 'notes.txt'), 'keep');
  assert.equal(await pruneAuditRecords({ directory, retentionDays: 30,
    now: Date.parse(record.timestamp) + 31 * 86400000 }), 1);
  assert.deepEqual(await readdir(directory), ['notes.txt']);
});

test('zero-day retention stores nothing and invalid records are refused', async () => {
  assert.equal(await appendAuditRecord(record, { retentionDays: 0 }), null);
  await assert.rejects(() => appendAuditRecord({ ...record, source: secret },
    { retentionDays: 0 }), (error) => error.code === 'INVALID_AUDIT');
});
