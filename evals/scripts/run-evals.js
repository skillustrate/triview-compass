#!/usr/bin/env node
// Provider-neutral structural validation for review eval specifications.
// Behavioral model evaluations will be implemented through model adapters.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CASES_DIR = join(ROOT, 'evals', 'cases');
const FIXTURES_DIR = join(ROOT, 'evals', 'fixtures');
const CONTRACTS_DIR = join(ROOT, 'contracts', 'schemas');
const caseArg = process.argv.indexOf('--case');
const caseFilter = caseArg >= 0 ? process.argv[caseArg + 1] : null;

const requiredFiles = [
  'agents/README.md',
  'agents/code-quality-reviewer.md',
  'agents/security-reviewer.md',
  'agents/performance-reviewer.md',
  'skills/README.md',
  'skills/core-review/SKILL.md',
  'skills/security-review/SKILL.md',
  'skills/performance-review/SKILL.md',
  'skills/adversarial-input/SKILL.md',
  'contracts/README.md',
  'contracts/schemas/common.schema.json',
  'contracts/schemas/review-request.schema.json',
  'contracts/schemas/review-bundle.schema.json',
  'contracts/schemas/review-policy.schema.json',
  'contracts/schemas/adapter-capabilities.schema.json',
  'contracts/schemas/reviewer-result.schema.json',
  'contracts/schemas/preflight-report.schema.json',
  'contracts/schemas/consolidated-report.schema.json',
  'contracts/schemas/audit-record.schema.json',
  'adapters/README.md',
];

let failures = 0;
let caseCount = 0;

if (caseArg >= 0 && (!caseFilter || caseFilter.startsWith('--'))) {
  console.error('Expected a case name after --case.');
  process.exit(1);
}

for (const path of requiredFiles) {
  if (!existsSync(join(ROOT, path))) {
    console.error(`✗ required package file missing: ${path}`);
    failures++;
  }
}

if (!existsSync(CASES_DIR) || !statSync(CASES_DIR).isDirectory()) {
  console.error(`Eval case directory is missing: ${CASES_DIR}`);
  process.exit(1);
}

if (!existsSync(FIXTURES_DIR) || !statSync(FIXTURES_DIR).isDirectory()) {
  console.error(`Eval fixtures directory is missing: ${FIXTURES_DIR}`);
  process.exit(1);
}

const realFixturesDir = realpathSync(FIXTURES_DIR);
const realContractsDir = existsSync(CONTRACTS_DIR) ? realpathSync(CONTRACTS_DIR) : null;

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function collectLocalRefs(value, refs = []) {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const entry of value) collectLocalRefs(entry, refs);
    return refs;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(child)) {
      refs.push(child);
    } else {
      collectLocalRefs(child, refs);
    }
  }
  return refs;
}

const schemaFiles = existsSync(CONTRACTS_DIR) && statSync(CONTRACTS_DIR).isDirectory()
  ? readdirSync(CONTRACTS_DIR).filter((name) => name.endsWith('.schema.json'))
  : [];
if (schemaFiles.length === 0) {
  console.error('✗ contract schema directory is missing or empty');
  failures++;
} else {
  for (const name of schemaFiles) {
    const schemaPath = join(CONTRACTS_DIR, name);
    let schema;
    let realSchemaPath;
    try {
      realSchemaPath = realpathSync(schemaPath);
      if (!realContractsDir || !isWithin(realContractsDir, realSchemaPath) || !statSync(realSchemaPath).isFile()) {
        throw new Error('schema must be a file inside contracts/schemas');
      }
      schema = JSON.parse(readFileSync(realSchemaPath, 'utf8'));
      if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
        throw new Error('expected a JSON Schema Draft 2020-12 object');
      }
    } catch (error) {
      console.error(`✗ ${name}: invalid schema (${error.message})`);
      failures++;
      continue;
    }

    let invalidRef = false;
    for (const ref of collectLocalRefs(schema)) {
      const [refFile, refFragment] = ref.split('#', 2);
      const refPath = refFile ? resolve(CONTRACTS_DIR, refFile) : realSchemaPath;
      let targetDocument;
      let validRef = true;
      try {
        const realRefPath = realpathSync(refPath);
        if (!isWithin(realContractsDir, realRefPath) || !statSync(realRefPath).isFile()) {
          validRef = false;
        } else {
          targetDocument = JSON.parse(readFileSync(realRefPath, 'utf8'));
        }
      } catch {
        validRef = false;
      }
      if (!isWithin(CONTRACTS_DIR, refPath) || !validRef) {
        console.error(`✗ ${name}: invalid local schema reference "${ref}"`);
        failures++;
        invalidRef = true;
        continue;
      }

      if (refFragment) {
        let target = targetDocument;
        try {
          const pointer = decodeURIComponent(refFragment);
          if (!pointer.startsWith('/')) throw new Error('reference fragment is not a JSON pointer');
          for (const segment of pointer.slice(1).split('/')) {
            const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
            if (!target || typeof target !== 'object' || !(key in target)) {
              throw new Error('JSON pointer target does not exist');
            }
            target = target[key];
          }
        } catch {
          console.error(`✗ ${name}: unresolved local schema reference "${ref}"`);
          failures++;
          invalidRef = true;
        }
      }
    }
    if (!invalidRef) console.log(`✓ ${name}`);
  }
}

const caseFiles = readdirSync(CASES_DIR)
  .filter((name) => name.endsWith('.json'))
  .filter((name) => !caseFilter || name.startsWith(caseFilter));

if (caseFiles.length === 0) {
  console.error(`No eval case files found${caseFilter ? ` matching "${caseFilter}"` : ''}.`);
  process.exit(1);
}

for (const name of caseFiles) {
  const fullPath = join(CASES_DIR, name);
  let data;
  try {
    data = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    console.error(`✗ ${name}: invalid JSON (${error.message})`);
    failures++;
    continue;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.evals)) {
    console.error(`✗ ${name}: expected an "evals" array`);
    failures++;
    continue;
  }
  if (data.evals.length === 0) {
    console.error(`✗ ${name}: eval case file must contain at least one eval`);
    failures++;
    continue;
  }

  let caseProblems = 0;
  for (const evaluation of data.evals) {
    caseCount++;
    if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
      console.error(`✗ ${name}: each eval entry must be an object`);
      failures++;
      caseProblems++;
      continue;
    }
    if (!Array.isArray(evaluation.files ?? [])) {
      console.error(`✗ ${name} / ${evaluation.id ?? 'unnamed'}: "files" must be an array`);
      failures++;
      caseProblems++;
      continue;
    }
    if (typeof evaluation.prompt !== 'string' || !evaluation.prompt.trim()) {
      console.error(`✗ ${name} / ${evaluation.id ?? 'unnamed'}: missing prompt`);
      failures++;
      caseProblems++;
    }

    for (const fixture of evaluation.files ?? []) {
      if (typeof fixture !== 'string' || !fixture.trim()) {
        console.error(`✗ ${name} / ${evaluation.id ?? 'unnamed'}: fixture paths must be non-empty strings`);
        failures++;
        caseProblems++;
        continue;
      }
      const fixturePath = resolve(FIXTURES_DIR, fixture);
      if (!isWithin(FIXTURES_DIR, fixturePath) || !existsSync(fixturePath)) {
        console.error(`✗ ${name} / ${evaluation.id ?? 'unnamed'}: invalid or missing fixture "${fixture}"`);
        failures++;
        caseProblems++;
        continue;
      }

      const realFixturePath = realpathSync(fixturePath);
      if (
        !isWithin(realFixturesDir, realFixturePath) ||
        !statSync(realFixturePath).isFile()
      ) {
        console.error(`✗ ${name} / ${evaluation.id ?? 'unnamed'}: fixture must be a file inside evals/fixtures ("${fixture}")`);
        failures++;
        caseProblems++;
      }
    }
  }

  if (caseProblems === 0) console.log(`✓ ${name}`);
}

const CORPUS_CASES_DIR = join(ROOT, 'evals', 'corpus', 'cases');
let corpusCaseCount = 0;
const STATUSES = ['pending', 'run', 'dispositioned'];
const VERDICTS = ['confirmed', 'rejected', 'unresolved'];

if (existsSync(CORPUS_CASES_DIR) && statSync(CORPUS_CASES_DIR).isDirectory()) {
  for (const entry of readdirSync(CORPUS_CASES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(CORPUS_CASES_DIR, entry.name);
    const manifestPath = join(caseDir, 'case.json');
    corpusCaseCount++;
    let review;
    try {
      review = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      console.error(`✗ corpus/${entry.name}: invalid or missing case.json (${error.message})`);
      failures++;
      continue;
    }
    const problems = [];
    if (review.id !== entry.name) problems.push(`"id" must equal the directory name (${entry.name})`);
    if (!STATUSES.includes(review.status)) problems.push(`"status" must be one of ${STATUSES.join(', ')}`);
    if (!review.source?.repository || !review.source?.baseRevision || !review.source?.targetRevision) {
      problems.push('"source" must include repository, baseRevision, and targetRevision');
    }
    if (!review.groundTruth?.type || !review.groundTruth?.description) {
      problems.push('"groundTruth" must include type and description');
    }
    for (const field of ['requestPath', 'policyPath']) {
      const value = review[field];
      if (typeof value !== 'string' || !value) {
        problems.push(`"${field}" is required`);
        continue;
      }
      const resolved = resolve(caseDir, value);
      if (!existsSync(resolved)) {
        problems.push(`"${field}" does not resolve to an existing file: ${value}`);
        continue;
      }
      try {
        JSON.parse(readFileSync(resolved, 'utf8'));
      } catch {
        problems.push(`"${field}" does not contain valid JSON: ${value}`);
      }
    }
    if (review.status === 'dispositioned' && (review.runs ?? []).length === 0) {
      problems.push('status is "dispositioned" but no run is recorded');
    }
    for (const run of review.runs ?? []) {
      if (review.status === 'dispositioned' && (run.dispositions ?? []).length === 0
        && (typeof run.outcomeNote !== 'string' || !run.outcomeNote.trim())) {
        problems.push('a dispositioned run with zero findings to disposition must explain why via a non-empty "outcomeNote"');
      }
      for (const disposition of run.dispositions ?? []) {
        if (!VERDICTS.includes(disposition.verdict)) {
          problems.push(`disposition verdict must be one of ${VERDICTS.join(', ')}, got "${disposition.verdict}"`);
        }
      }
    }
    if (problems.length === 0) console.log(`✓ corpus/${entry.name}`);
    else for (const problem of problems) {
      console.error(`✗ corpus/${entry.name}: ${problem}`);
      failures++;
    }
  }
}

if (failures === 0) {
  console.log(`\nStructural check passed: ${caseFiles.length} case file(s), ${caseCount} evaluation(s), ${corpusCaseCount} corpus case(s).`);
  console.log('No model or network calls were made.');
} else {
  console.error(`\nStructural check found ${failures} problem(s).`);
  process.exitCode = 1;
}
