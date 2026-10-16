import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The consolidated report is this project's one public, stable output
// format (see docs/report-contract.md). additionalProperties: false
// throughout means almost any change to its schema -- or to a
// common.schema.json definition it references, or to the embedded
// preflight-report.schema.json -- is a breaking change for an external
// consumer holding a frozen copy, not a safely-additive one. This test pins
// those three files' exact bytes so a change is a loud, deliberate decision
// (bump contractVersion, update docs/report-contract.md and this hash, note
// it in RELEASE.md) rather than silent drift.
const PINNED_SHA256 = '50ecb1ee55bb23f4a75cbb1a7817c70bc01ad975ae1a0bb4b15c6befa689a699';

const FILES = ['consolidated-report.schema.json', 'common.schema.json', 'preflight-report.schema.json'];

test('the public report contract schema surface is pinned to a known hash', async () => {
  const hash = createHash('sha256');
  for (const filename of FILES) {
    hash.update(filename);
    hash.update(await readFile(new URL(`../contracts/schemas/${filename}`, import.meta.url)));
  }
  assert.equal(hash.digest('hex'), PINNED_SHA256,
    'The report contract schema surface changed. If this is intentional: bump contractVersion, '
    + 'update docs/report-contract.md and RELEASE.md to describe the change, then update PINNED_SHA256 '
    + 'in this test to match. See docs/report-contract.md\'s "Versioning policy" section.');
});
