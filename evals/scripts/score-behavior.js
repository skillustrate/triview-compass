import { assertConsolidatedReport } from '../../src/core/contracts.js';

// Anchored keyword oracles are reproducible checks, not proof of model truthfulness.
export function scoreBehaviorCase(spec, report, { baseline = false } = {}) {
  assertConsolidatedReport(report);
  const matches = spec.expectedFindings.map((expected) => {
    const pattern = new RegExp(expected.pattern, 'iu');
    const finding = report.findings.find((item) => item.evidence.path === expected.path
      && item.evidence.startLine <= expected.endLine && item.evidence.endLine >= expected.startLine
      && (expected.maxEvidenceLines === undefined
        || item.evidence.endLine - item.evidence.startLine + 1 <= expected.maxEvidenceLines)
      && ['Critical', 'Required'].includes(item.severity)
      && expected.categories.includes(item.category)
      && (baseline || item.sourceFindings.some((source) => source.reviewer === expected.reviewer))
      && pattern.test(`${item.title} ${item.impact} ${item.recommendation ?? ''}`));
    return { id: expected.id, matched: finding !== undefined, findingId: finding?.id ?? null };
  });
  const completed = report.status !== 'incomplete';
  const independent = baseline ? report.reviewers.filter((item) => item.status === 'completed').length === 1
    : report.reviewers.length === 3 && report.reviewers.every((item) => item.status === 'completed');
  const misses = matches.filter((item) => !item.matched).map((item) => item.id);
  const anchorViolations = report.findings.filter((finding) => spec.expectedFindings.some((expected) => {
    if (expected.maxEvidenceLines === undefined || finding.evidence.path !== expected.path
      || !expected.categories.includes(finding.category)
      || !new RegExp(expected.pattern, 'iu').test(`${finding.title} ${finding.impact} ${finding.recommendation ?? ''}`)) return false;
    return finding.evidence.startLine > expected.endLine || finding.evidence.endLine < expected.startLine
      || finding.evidence.endLine - finding.evidence.startLine + 1 > expected.maxEvidenceLines;
  })).length;
  const falseAlerts = spec.expectZeroFindings ? report.findings.length : null;
  const unexpected = report.findings.filter((item) => !matches.some((match) => match.findingId === item.id)).length;
  const offScope = report.findings.filter((item) => ['correctness', 'security', 'privacy'].includes(item.category)
    && item.sourceFindings.some((source) => source.reviewer === 'performance')).length;
  return { passed: completed && independent && misses.length === 0
      && (falseAlerts === null || falseAlerts === 0) && report.unverifiableFindings.length === 0 && offScope === 0 && anchorViolations === 0,
    checks: { completed, independent, allStructuralEvidenceVerified: report.unverifiableFindings.length === 0 },
    matches: matches.map(({ id, matched }) => ({ id, matched })), misses,
    cleanFalseAlerts: falseAlerts, unexpectedFindingCandidates: unexpected,
    performanceOffScopeFindings: offScope, disagreementCount: report.findings.filter((item) => item.disagreement).length,
    semanticAnchorViolations: anchorViolations,
    findingCount: report.findings.length, unverifiableCount: report.unverifiableFindings.length };
}
