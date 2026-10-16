// Source-free diagnostic for a local LM Studio-compatible REST server.
// Run only inside the project test container. This is not a preflight counter.
import { readFileSync } from 'node:fs';
import { createLmStudioModelAdapter } from '../../src/adapters/model/lm-studio.js';
import { preflightFiles } from '../../src/core/preflight.js';
import { buildReviewerPrompts } from '../../src/core/prompt-builder.js';

const [baseUrl, modelId] = process.argv.slice(2);
if (!baseUrl || !modelId) {
  process.stderr.write('Usage: node evals/scripts/probe-rest-token-count.js <base-url> <model-id>\n');
  process.exitCode = 2;
} else {
  const origin = new URL(baseUrl).origin;
  const samples = [
    ['short', 'Count this synthetic input.'],
    ['code-like', 'Review this synthetic code sample: function sum(a, b) { return a + b; }'],
    ['unicode', 'Synthetic text: नमस्ते こんにちは café 🚀'],
    ['repeated', `Synthetic repeated words: ${'alpha beta gamma '.repeat(40)}`],
  ];
  const policy = JSON.parse(readFileSync(new URL('../../examples/default-policy.json', import.meta.url)));
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'synthetic/example.js', changeType: 'added', content: 'export function sum(a, b) { return a + b; }\n' },
  ] } }, policy);
  const prompts = buildReviewerPrompts(bundle, policy).prompts;
  const adapter = createLmStudioModelAdapter({ baseUrl, modelId });
  for (const role of policy.reviewers) {
    const payload = adapter.prepareRequest({ role, prompt: prompts[role], modelId, maxOutputTokens: 1 });
    samples.push([`review-${role}`, JSON.parse(payload).input]);
  }
  try {
    for (const [name, input] of samples) {
      const response = await fetch(`${origin}/api/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, input, store: false, stream: false,
          integrations: [], reasoning: 'off', temperature: 0, max_output_tokens: 1 }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const actual = data?.stats?.input_tokens;
      if (data.model_instance_id !== modelId || !Number.isSafeInteger(actual)
        || actual < 1 || data.response_id !== undefined) {
        throw new Error('Unexpected model, token count, or stored response');
      }
      process.stdout.write(JSON.stringify({ sample: name,
        inputUtf8Bytes: Buffer.byteLength(input, 'utf8'), actualInputTokens: actual }) + '\n');
    }
  } catch (error) {
    process.stderr.write(`Token-count probe failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
