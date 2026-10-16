function terminalSafe(value) {
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (Array.isArray(value)) return value.map(terminalSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, terminalSafe(item)]));
  }
  return value;
}

// Text is for people; JSON remains the stable automation format.
export function formatReport(report) {
  report = terminalSafe(report);
  if (report.kind === 'preflight') {
    if (report.status === 'refused') return `Preflight: refused (${report.code})\n${report.reason}\n`;
    const lines = [`Preflight: ready (${report.mode})`,
      `Source handling: ${report.hostedSourceDisclosure ? 'sanitized source will reach an approved hosted provider' : 'local processing'}`,
      `Coverage: ${Object.entries(report.scopeCounts).map(([state, count]) => `${state}=${count}`).join(', ')}`];
    lines.push(`Harness controls: ${Object.entries(report.harness.controls).map(([name, state]) => `${name}=${state}`).join(', ')}`);
    for (const item of report.reviewers) {
      lines.push(`${item.role}: ${item.providerId}/${item.modelId} via ${item.adapterId}; ${item.dataHandling}; input bound ${item.inputTokenUpperBound} tokens`);
      lines.push(`  Controls: ${Object.entries(item.controls).map(([name, state]) => `${name}=${state}`).join(', ')}`);
    }
    lines.push(`Sandbox: ${report.sandbox?.status ?? 'not-requested'}${report.sandbox?.reason ? ` — ${report.sandbox.reason}` : ''}`);
    if (report.sandbox?.guidance) lines.push(`Runtime guidance: ${report.sandbox.guidance}`);
    lines.push(`Audit: ${report.audit?.enabled ? `${report.audit.retentionDays} days, metadata only` : 'disabled'}`);
    for (const limitation of report.limitations) lines.push(`Limitation: ${limitation}`);
    return `${lines.join('\n')}\n`;
  }
  const lines = [`Review: ${report.status}; verdict: ${report.verdict}`, `Snapshot: ${report.snapshotSha256}`];
  for (const item of report.reviewers) lines.push(`${item.role}: ${item.status}${item.adapter ? ` (${item.adapter.providerId}/${item.adapter.modelId} via ${item.adapter.adapterId})` : ''}${item.reason ? ` — ${item.reason}` : ''}`);
  lines.push(`Coverage: ${report.coverage.includedPaths.length} included, ${report.coverage.excludedPaths.length} excluded`);
  for (const finding of report.findings) {
    lines.push(`${finding.severity}: ${finding.title} (${finding.evidence.path}:${finding.evidence.startLine ?? 'hunk'})`,
      `  ${finding.impact}`);
    if (finding.recommendation) lines.push(`  Suggested change: ${finding.recommendation}`);
    if (finding.disagreement) lines.push('  Reviewer severity disagreement retained.');
  }
  for (const finding of report.unverifiableFindings) lines.push(`Unverifiable: ${finding.title} (${finding.reason})`);
  if (report.sandbox) {
    lines.push(`Sandbox: ${report.sandbox.status}${report.sandbox.reason ? ` — ${report.sandbox.reason}` : ''}`);
    if (report.sandbox.guidance) lines.push(`Runtime guidance: ${report.sandbox.guidance}`);
    if (report.sandbox.stdout) lines.push(`Sandbox stdout (scanned):\n${report.sandbox.stdout}`);
    if (report.sandbox.stderr) lines.push(`Sandbox stderr (scanned):\n${report.sandbox.stderr}`);
  }
  for (const item of report.coverage.skippedChecks) lines.push(`Skipped: ${item}`);
  for (const item of report.limitations) lines.push(`Limitation: ${item}`);
  return `${lines.join('\n')}\n`;
}
