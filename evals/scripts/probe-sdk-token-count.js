// Source-free check of the LM Studio SDK tokenizer. Run inside dev-box only.
import { LMStudioClient } from '@lmstudio/sdk';
import { readFileSync } from 'node:fs';
import { createStaticReviewHarnessAdapter } from '../../src/adapters/harness/static-review.js';
import { createLmStudioModelAdapter } from '../../src/adapters/model/lm-studio.js';
import { preflightFiles } from '../../src/core/preflight.js';
import { buildReviewerPrompts } from '../../src/core/prompt-builder.js';
import { prepareReviewInputs } from '../../src/core/prepare-review.js';

const [serverUrl, modelId] = process.argv.slice(2);
if (!serverUrl || !modelId) {
  process.stderr.write('Usage: node evals/scripts/probe-sdk-token-count.js <server-url> <model-id>\n');
  process.exitCode = 2;
} else {
  const url = new URL(serverUrl);
  const wsBaseUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  const client = new LMStudioClient({ baseUrl: wsBaseUrl });
  try {
    const model = await client.llm.model(modelId);
    const contextLength = await model.getContextLength();
    const formatted = await model.applyPromptTemplate([
      { role: 'user', content: 'Synthetic token check.' },
    ]);
    const inputTokens = await model.countTokens(formatted);
    if (!Number.isSafeInteger(contextLength) || contextLength < 1
      || !Number.isSafeInteger(inputTokens) || inputTokens < 1) {
      throw new Error('The SDK returned invalid context or token counts.');
    }
    process.stdout.write(JSON.stringify({ modelId, contextLength, inputTokens }) + '\n');
    const policy = JSON.parse(readFileSync(new URL('../../examples/default-policy.json', import.meta.url)));
    const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
      { path: 'synthetic/example.js', changeType: 'added', content: 'export function sum(a, b) { return a + b; }\n' },
    ] } }, policy);
    const prompts = buildReviewerPrompts(bundle, policy).prompts;
    const adapter = createLmStudioModelAdapter({ baseUrl: serverUrl, modelId, sdkClient: client });
    for (const role of policy.reviewers) {
      const payload = adapter.prepareRequest({ role, prompt: prompts[role],
        modelId, maxOutputTokens: 1 });
      const count = await adapter.countInputTokens({ payload, modelId });
      process.stdout.write(JSON.stringify({ role, inputTokenUpperBound: count.upperBound,
        contextLength }) + '\n');
    }
    policy.dataPolicy.selectedProvider = 'lm-studio-local';
    policy.dataPolicy.allowedProviders = ['lm-studio-local'];
    const harnessAdapter = createStaticReviewHarnessAdapter({ policy, bundle });
    const plan = await prepareReviewInputs(policy, bundle, { harnessAdapter, modelAdapter: adapter });
    process.stdout.write(JSON.stringify({ syntheticHandshake: 'passed',
      roles: plan.requests.map((request) => request.role),
      bounds: plan.readiness.inputTokenBounds }) + '\n');
  } catch (error) {
    process.stderr.write(`SDK token-count probe failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await client[Symbol.asyncDispose]();
  }
}
