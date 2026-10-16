// Source-free diagnostic for LM Studio's schema-constrained chat endpoint.
import { readFileSync } from 'node:fs';
import { LMStudioClient } from '@lmstudio/sdk';
import { preflightFiles } from '../../src/core/preflight.js';
import { buildReviewerPrompts } from '../../src/core/prompt-builder.js';

const [baseUrl, modelId, reasoningMode] = process.argv.slice(2);
if (!baseUrl || !modelId) {
  process.stderr.write('Usage: node evals/scripts/probe-structured-output.js <base-url> <model-id> [--reasoning-effort-none|--reasoning-none]\n');
  process.exitCode = 2;
} else {
  const policy = JSON.parse(readFileSync(new URL('../../examples/default-policy.json', import.meta.url)));
  policy.mode = 'partial';
  policy.reviewers = ['code-quality'];
  const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'synthetic/users.js', changeType: 'added', content:
      'export function findUser(users, id) {\n  return users.find((user) => (user.id = id));\n}\n' },
  ] } }, policy);
  const prompt = buildReviewerPrompts(bundle, policy).prompts['code-quality'];
  const finding = { type: 'object', additionalProperties: false,
    required: ['id', 'category', 'severity', 'title', 'impact', 'evidence', 'confidence', 'skill'],
    properties: {
      id: { type: 'string' },
      category: { type: 'string', enum: ['correctness', 'security', 'performance', 'maintainability',
        'architecture', 'testing', 'privacy', 'supply-chain', 'reliability', 'other'] },
      severity: { type: 'string', enum: ['Critical', 'Required', 'Optional', 'Nit'] },
      title: { type: 'string' }, impact: { type: 'string' },
      evidence: { type: 'object', additionalProperties: false,
        required: ['path', 'startLine', 'endLine'], properties: {
          path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' },
        } },
      confidence: { type: 'number' }, skill: { type: 'string', enum: ['core-review'] },
    } };
  const body = { model: modelId, messages: [
    { role: 'system', content: 'Return only JSON matching the schema. Cite opaque file ID F0001 and line numbers. Do not use markdown.' },
    { role: 'user', content: prompt },
  ], response_format: { type: 'json_schema', json_schema: {
    name: 'triview_review', strict: true,
    schema: { type: 'object', additionalProperties: false, required: ['findings', 'verdict'],
      properties: { findings: { type: 'array', items: finding },
        verdict: { type: 'string', enum: ['recommend-approval', 'request-changes'] } } },
  } }, temperature: 0, max_tokens: 600, stream: false,
  ...(reasoningMode === '--reasoning-effort-none' ? { reasoning_effort: 'none' } : {}),
  ...(reasoningMode === '--reasoning-none' ? { reasoning: { effort: 'none' } } : {}) };
  const url = new URL(baseUrl);
  const client = new LMStudioClient({ baseUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` });
  try {
    const model = await client.llm.model(modelId);
    const formatted = await model.applyPromptTemplate(body.messages);
    const sdkInputTokens = await model.countTokens(formatted);
    const response = await fetch(`${new URL(baseUrl).origin}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
    const message = data.choices?.[0]?.message;
    process.stdout.write(JSON.stringify({ model: data.model, sdkInputTokens, usage: data.usage,
      finishReason: data.choices?.[0]?.finish_reason,
      contentPresent: typeof message?.content === 'string' && message.content.length > 0,
      reasoningPresent: typeof message?.reasoning_content === 'string'
        && message.reasoning_content.length > 0 }) + '\n');
  } catch (error) {
    process.stderr.write(`Structured-output probe failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await client[Symbol.asyncDispose]();
  }
}
