import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCorpus } from '../evals/scripts/score-corpus.js';

function caseWith(overrides) {
  return { id: 'x', status: 'dispositioned', groundTruth: { type: 'known-fix' }, runs: [], ...overrides };
}

test('a pending case is excluded from disposition metrics but counted in corpus size', () => {
  const metrics = scoreCorpus([caseWith({ status: 'pending', runs: [] })]);
  assert.equal(metrics.corpusSize, 1);
  assert.equal(metrics.dispositionedCases, 0);
  assert.equal(metrics.pendingCases, 1);
  assert.equal(metrics.totalDispositions, 0);
});

test('confirmed-blocking rate counts only Critical/Required severities', () => {
  const metrics = scoreCorpus([caseWith({
    runs: [{ dispositions: [
      { severity: 'Critical', verdict: 'confirmed' },
      { severity: 'Optional', verdict: 'confirmed' },
      { severity: 'Required', verdict: 'rejected', reasonCode: 'incorrect-claim' },
    ] }],
  })]);
  assert.equal(metrics.blockingFindings, 2);
  assert.equal(metrics.confirmedBlockingTruePositiveRate, 0.5);
});

test('wrong-anchor rate is measured across all severities, not only blocking ones', () => {
  const metrics = scoreCorpus([caseWith({
    runs: [{ dispositions: [
      { severity: 'Optional', verdict: 'rejected', reasonCode: 'wrong-anchor' },
      { severity: 'Optional', verdict: 'rejected', reasonCode: 'incorrect-claim' },
    ] }],
  })]);
  assert.equal(metrics.rejectedBlockingCount, 0);
  assert.equal(metrics.rejectedCount, 2);
  assert.equal(metrics.wrongAnchorRateAmongRejected, 0.5);
});

test('a known-defect-present case not confirmed anywhere counts as missed', () => {
  const metrics = scoreCorpus([
    caseWith({ groundTruth: { type: 'known-defect-present' }, runs: [{ dispositions: [{ severity: 'Required', verdict: 'rejected' }] }] }),
  ]);
  assert.equal(metrics.knownDefectCases, 1);
  assert.equal(metrics.knownDefectMissedCount, 1);
});

test('a known-defect-present case confirmed in any run counts as found, not missed', () => {
  const metrics = scoreCorpus([
    caseWith({ groundTruth: { type: 'known-defect-present' }, runs: [{ dispositions: [{ severity: 'Required', verdict: 'confirmed' }] }] }),
  ]);
  assert.equal(metrics.knownDefectMissedCount, 0);
});

test('rates are null rather than divide-by-zero when there is nothing to divide', () => {
  const metrics = scoreCorpus([caseWith({ runs: [] })]);
  assert.equal(metrics.confirmedBlockingTruePositiveRate, null);
  assert.equal(metrics.wrongAnchorRateAmongRejected, null);
});
