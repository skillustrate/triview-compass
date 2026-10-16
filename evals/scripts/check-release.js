#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { preflightFiles, scanSecrets } from '../../src/core/preflight.js';
import { buildReviewerPrompts } from '../../src/core/prompt-builder.js';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const pkg = JSON.parse(await read('package.json'));
if (pkg.private !== true) throw new Error('Preview package must remain private.');
for (const path of ['RELEASE.md', 'SECURITY.md', 'docs/capability-matrix.md', 'docs/security-review.md']) await read(path);
const suite = JSON.parse(await read('evals/behavior/suite.json'));
const coverage = JSON.parse(await read('evals/security/threat-coverage.json'));
if (coverage.threats.length !== 10 || new Set(coverage.threats.map((item) => item.id)).size !== 10) {
  throw new Error('All ten threat rows must be mapped exactly once.');
}
for (const threat of coverage.threats) {
  if (!threat.residualRisk || threat.tests.length === 0) throw new Error('Every threat needs tests and a residual-risk statement.');
  for (const test of threat.tests) {
    if (!/^tests\/[a-z0-9-]+\.test\.js$/u.test(test.file)
      || !(await read(test.file)).includes(test.name)) throw new Error(`Missing named test for ${threat.id}.`);
  }
  for (const id of threat.behaviorCases) {
    if (!suite.cases.some((item) => item.id === id)) throw new Error('Unknown behavior fixture.');
  }
}
const evidence = JSON.parse(await read('evals/evidence/evidence-context-sonnet-2026-10-15-cli2.1.300.json'));
const suiteHash = createHash('sha256').update(await read('evals/behavior/suite.json')).digest('hex');
if (evidence.status !== 'completed' || evidence.suiteSha256 !== suiteHash) throw new Error('Complete current-suite model evidence is required.');
const guidancePaths = [];
for (const folder of ['agents', 'skills/reviewer-briefs']) {
  for (const name of await readdir(new URL(`${folder}/`, root))) {
    if ((folder === 'agents' && name.endsWith('-reviewer.md')) || (folder !== 'agents' && name.endsWith('.md'))) guidancePaths.push(`${folder}/${name}`);
  }
}
const guidanceHash = createHash('sha256');
for (const path of guidancePaths.sort()) guidanceHash.update(`${path}\0`).update(await read(path)).update('\0');
if (evidence.guidanceSha256 !== guidanceHash.digest('hex')) throw new Error('Model evidence must match current reviewer guidance.');
const policy = JSON.parse(await read('examples/default-policy.json'));
const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'version.js', changeType: 'added', content: 'const version = 1;\n' },
] } }, policy);
const versions = new Map(buildReviewerPrompts(bundle, policy).promptVersions.map(({ role, version }) => [role, version]));
for (const spec of suite.cases) {
  for (const mode of ['three-reviewers', 'single-code-quality']) {
    const row = evidence.runs.find((row) => row.caseId === spec.id && row.mode === mode);
    if (!row) throw new Error('Missing case or baseline measurement.');
    const roles = mode === 'three-reviewers' ? [...versions.keys()] : ['code-quality'];
    if (!roles.every((role) => row.promptVersions?.some((item) => item.role === role && item.version === versions.get(role)))) {
      throw new Error('Model evidence must match current prompt format and instructions.');
    }
  }
}
if (scanSecrets(JSON.stringify(evidence)).length > 0) throw new Error('Unsafe evaluation metadata.');
const audit = JSON.parse(await read('evals/evidence/dependency-audit-2026-10-14.json'));
if (audit.metadata?.vulnerabilities?.total !== 0) throw new Error('Dependency audit contains known vulnerabilities or unavailable results.');
process.stdout.write(`Private preview release checks passed: ${coverage.threats.length} mapped threats, ${suite.cases.length} model cases with baselines, current guidance evidence, zero known dependency advisories.\n`);
process.stdout.write('Model-quality scores are advisory. No package was published.\n');
