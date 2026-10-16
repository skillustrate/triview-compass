// Diagnostic only: synthetic source and the static harness, never a repository review.
import { readFileSync } from 'node:fs';
import { createStaticReviewHarnessAdapter } from '../../src/adapters/harness/static-review.js';
import { createLmStudioModelAdapter } from '../../src/adapters/model/lm-studio.js';
import { preflightFiles } from '../../src/core/preflight.js';
import { runReview } from '../../src/core/review-dispatch.js';

const [baseUrl, modelId, mode] = process.argv.slice(2);
if (!baseUrl || !modelId) {
  process.stderr.write('Usage: node evals/scripts/probe-synthetic-review.js <base-url> <model-id> [--full]\n');
  process.exitCode = 2;
} else {
  const policy = JSON.parse(readFileSync(new URL('../../examples/default-policy.json', import.meta.url)));
  if (mode !== '--full') {
    policy.mode = 'partial';
    policy.reviewers = ['code-quality'];
  }
  policy.dataPolicy.selectedProvider = 'lm-studio-local';
  policy.dataPolicy.allowedProviders = ['lm-studio-local'];
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'synthetic/users.js', changeType: 'added', content:
      'export function findUser(users, id) {\n  return users.find((user) => (user.id = id));\n}\n' },
  ] } }, policy);
  const harnessAdapter = createStaticReviewHarnessAdapter({ policy, bundle });
  let chatResponse;
  const fetchImpl = async (...args) => {
    const response = await fetch(...args);
    if (args[0].endsWith('/v1/chat/completions')) {
      try { chatResponse = await response.clone().json(); } catch { /* adapter handles invalid JSON */ }
    }
    return response;
  };
  const modelAdapter = createLmStudioModelAdapter({ baseUrl, modelId, fetchImpl });
  try {
    const report = await runReview(policy, bundle, { harnessAdapter, modelAdapter });
    process.stdout.write(JSON.stringify({ status: report.status, verdict: report.verdict,
      reviewers: report.reviewers, findings: report.findings,
      limitations: report.limitations,
      ...(report.status === 'incomplete' ? { lastChat: {
        finishReason: chatResponse?.choices?.[0]?.finish_reason,
        usage: chatResponse?.usage,
        contentPresent: Boolean(chatResponse?.choices?.[0]?.message?.content),
        reasoningPresent: Boolean(chatResponse?.choices?.[0]?.message?.reasoning_content),
      } } : {}) }) + '\n');
    if (report.status !== (mode === '--full' ? 'complete' : 'partial')) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Synthetic review probe failed: ${error.code ?? 'UNKNOWN'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
