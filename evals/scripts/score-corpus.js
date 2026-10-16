#!/usr/bin/env node
// Aggregates manual dispositions recorded in evals/corpus/cases/*/case.json
// into the precision/missed-defect/wrong-anchor metrics plan.md Phase 7
// requires, and appends one line to evals/corpus/metrics-log.jsonl. This
// reads only already-saved case manifests and reports; it makes no model or
// network calls and does not run a review itself.
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, '../corpus');
const CASES_DIR = join(CORPUS_DIR, 'cases');
const LOG_PATH = join(CORPUS_DIR, 'metrics-log.jsonl');

function loadCases() {
  return readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(CASES_DIR, entry.name, 'case.json'), 'utf8')));
}

function allDispositions(cases) {
  const rows = [];
  for (const review of cases) {
    for (const run of review.runs ?? []) {
      for (const disposition of run.dispositions ?? []) {
        rows.push({ caseId: review.id, ...disposition });
      }
    }
  }
  return rows;
}

export function scoreCorpus(cases) {
  const dispositioned = cases.filter((review) => review.status === 'dispositioned');
  const pending = cases.filter((review) => review.status !== 'dispositioned');
  const rows = allDispositions(dispositioned);
  const blocking = rows.filter((row) => ['Critical', 'Required'].includes(row.severity));
  const confirmedBlocking = blocking.filter((row) => row.verdict === 'confirmed').length;
  const rejectedBlocking = blocking.filter((row) => row.verdict === 'rejected').length;
  const unresolvedBlocking = blocking.filter((row) => row.verdict === 'unresolved').length;
  const rejectedAll = rows.filter((row) => row.verdict === 'rejected').length;
  const wrongAnchor = rows.filter((row) => row.verdict === 'rejected' && row.reasonCode === 'wrong-anchor').length;
  const knownDefectCases = dispositioned.filter((review) => review.groundTruth?.type === 'known-defect-present');
  const knownDefectFound = knownDefectCases.filter((review) =>
    (review.runs ?? []).some((run) => (run.dispositions ?? []).some((disposition) => disposition.verdict === 'confirmed')));
  return {
    generatedAt: new Date().toISOString(),
    corpusSize: cases.length,
    dispositionedCases: dispositioned.length,
    pendingCases: pending.length,
    pendingCaseIds: pending.map((review) => review.id),
    totalDispositions: rows.length,
    blockingFindings: blocking.length,
    confirmedBlockingTruePositiveRate: blocking.length === 0 ? null : confirmedBlocking / blocking.length,
    rejectedBlockingCount: rejectedBlocking,
    unresolvedBlockingCount: unresolvedBlocking,
    rejectedCount: rejectedAll,
    wrongAnchorRateAmongRejected: rejectedAll === 0 ? null : wrongAnchor / rejectedAll,
    knownDefectCases: knownDefectCases.length,
    knownDefectMissedCount: knownDefectCases.length - knownDefectFound.length,
    caveat: 'These rates describe only the cases in this corpus. No sample size here establishes general accuracy — see plan.md Phase 7 and README.md for the required corpus size and diversity before treating this as representative.',
  };
}

function main() {
  const cases = loadCases();
  const metrics = scoreCorpus(cases);
  appendFileSync(LOG_PATH, `${JSON.stringify(metrics)}\n`);
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  if (metrics.corpusSize < 20) {
    process.stderr.write(`Corpus has ${metrics.corpusSize} case(s); plan.md Phase 7 targets 20-30 before this is treated as representative.\n`);
  }
  if (metrics.pendingCases > 0) {
    process.stderr.write(`${metrics.pendingCases} case(s) still pending a live run: ${metrics.pendingCaseIds.join(', ')}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
