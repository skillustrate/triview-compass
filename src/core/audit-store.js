import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertAuditRecord } from './contracts.js';
import { PreflightError } from './errors.js';

const NAME = /^audit-[0-9a-f-]{36}\.json$/u;
const MAX_RECORD_BYTES = 64 * 1024;

function invalid() {
  throw new PreflightError('INVALID_AUDIT_STORE', 'The audit store configuration or contents are invalid.');
}

async function ensureDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) invalid();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) invalid();
}

function checkRetention(retentionDays) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) invalid();
}

export function assertAuditConfiguration({ directory, retentionDays } = {}) {
  checkRetention(retentionDays);
  if (typeof directory !== 'string' || directory.length === 0) invalid();
}

// Persistence is opt-in: callers must supply a directory and a retention period.
// Only schema-validated metadata is accepted. A zero-day period disables storage.
export async function appendAuditRecord(record, { directory, retentionDays } = {}) {
  checkRetention(retentionDays);
  assertAuditRecord(record);
  if (retentionDays === 0) return null;
  await ensureDirectory(directory);
  const pathname = join(directory, `audit-${randomUUID()}.json`);
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) invalid();
  const handle = await open(pathname, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(pathname);
    throw error;
  }
  await handle.close();
  await pruneAuditRecords({ directory, retentionDays });
  return pathname;
}

export async function pruneAuditRecords({ directory, retentionDays, now = Date.now() } = {}) {
  checkRetention(retentionDays);
  if (!Number.isSafeInteger(now) || now < 0) invalid();
  await ensureDirectory(directory);
  const cutoff = now - retentionDays * 86400000;
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !NAME.test(entry.name)) continue;
    const pathname = join(directory, entry.name);
    let record;
    try {
      const stat = await lstat(pathname);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      record = JSON.parse(await readFile(pathname, 'utf8'));
      assertAuditRecord(record);
    } catch { continue; }
    if (Date.parse(record.timestamp) < cutoff) {
      await unlink(pathname);
      removed++;
    }
  }
  return removed;
}
