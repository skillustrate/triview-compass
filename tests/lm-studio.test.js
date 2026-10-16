import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createLmStudioModelAdapter } from '../src/adapters/model/lm-studio.js';

const MODEL = 'gemma-4-26b-a4b-it-qat';
const metadata = { models: [{ key: MODEL, type: 'llm', format: 'gguf',
  loaded_instances: [{ id: MODEL, config: { context_length: 16384 } }] }] };
const prompt = JSON.stringify({ role: 'security', reviewId: 'review-1',
  snapshotSha256: 'a'.repeat(64), promptVersion: 'b'.repeat(64),
  skills: [{ id: 'core-review' }, { id: 'security-review' }, { id: 'adversarial-input-review' }] });

function fixture({ modelMetadata = metadata, reply } = {}) {
  const calls = [];
  const sdkClient = { llm: { model: async (id) => {
    assert.equal(id, MODEL);
    return { getContextLength: async () => 16384,
      applyPromptTemplate: async (messages) => JSON.stringify(messages),
      countTokens: async () => 100 };
  } } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/v1/models')) return Response.json(modelMetadata);
    return Response.json(reply ?? { model: MODEL,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ findings: [], verdict: 'recommend-approval' }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 25 } });
  };
  const adapter = createLmStudioModelAdapter({ baseUrl: 'http://localhost:1235/v1',
    modelId: MODEL, sdkClient, fetchImpl });
  return { adapter, calls };
}

function invocation(payload, bound) {
  return { role: 'security', invocationId: 'invocation-1', payload,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    inputTokenUpperBound: bound, maxOutputTokens: 1024,
    freshContext: true, memoryEnabled: false, tools: [], signal: new AbortController().signal };
}

test('LM Studio adapter sends the exact stateless request and validates the response', async () => {
  const { adapter, calls } = fixture();
  const capabilities = await adapter.verifyRuntime();
  assert.ok(calls.every((call) => call.options.redirect === 'error'));
  assert.equal(capabilities.dataHandling, 'local');
  assert.equal(capabilities.contextWindowTokens, 16384);
  const payload = adapter.prepareRequest({ role: 'security', prompt, modelId: MODEL, maxOutputTokens: 1024 });
  const body = JSON.parse(payload);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, prompt);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.tools, undefined);
  assert.equal(body.stream, false);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.max_tokens, 1024);
  const count = await adapter.countInputTokens({ payload, modelId: MODEL });
  assert.deepEqual(count, { upperBound: 356, conservative: true });
  const result = await adapter.invokeReview(invocation(payload, count.upperBound));
  assert.ok(calls.every((call) => call.options.redirect === 'error'));
  assert.equal(result.reviewer, 'security');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.findings, []);
  const chat = calls.find((call) => call.url.endsWith('/v1/chat/completions'));
  assert.equal(chat.options.body, payload);
  assert.equal(chat.options.signal.aborted, false);
  assert.equal(chat.options.method, 'POST');
});

test('LM Studio adapter refuses unloaded or nonlocal models before prompt preparation', async () => {
  const { adapter } = fixture({ modelMetadata: { models: [{ ...metadata.models[0], loaded_instances: [] }] } });
  await assert.rejects(() => adapter.verifyRuntime(), (error) => error.code === 'CAPABILITY_UNAVAILABLE');
  const cloud = fixture({ modelMetadata: { models: [{ ...metadata.models[0], format: 'cloud' }] } });
  await assert.rejects(() => cloud.adapter.getCapabilities(), (error) => error.code === 'CAPABILITY_UNAVAILABLE');
});

test('LM Studio adapter refuses unsafe invocation settings before a chat request', async () => {
  const { adapter, calls } = fixture();
  const payload = adapter.prepareRequest({ role: 'security', prompt, modelId: MODEL, maxOutputTokens: 1024 });
  await assert.rejects(() => adapter.invokeReview({ ...invocation(payload, 356), tools: ['shell'] }),
    (error) => error.code === 'INVALID_ADAPTER_REQUEST');
  assert.equal(calls.some((call) => call.url.endsWith('/v1/chat/completions')), false);
});

test('LM Studio adapter rejects tool, mismatched, truncated and over-budget responses', async () => {
  const base = { model: MODEL,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant',
      content: JSON.stringify({ findings: [], verdict: 'recommend-approval' }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 25 } };
  for (const reply of [
    { ...base, choices: [{ ...base.choices[0], message: { ...base.choices[0].message,
      tool_calls: [{ function: { name: 'shell' } }] } }] },
    { ...base, model: 'another-model' },
    { ...base, choices: [{ ...base.choices[0], finish_reason: 'length' }] },
    { ...base, usage: { prompt_tokens: 400, completion_tokens: 25 } },
    { ...base, usage: { prompt_tokens: 100, completion_tokens: 1025 } },
  ]) {
    const { adapter } = fixture({ reply });
    const payload = adapter.prepareRequest({ role: 'security', prompt, modelId: MODEL, maxOutputTokens: 1024 });
    await assert.rejects(() => adapter.invokeReview(invocation(payload, 356)),
      (error) => error.code === 'ADAPTER_FAILED');
  }
});

test('LM Studio adapter fails closed when the SDK tokenizer is inaccessible', async () => {
  const { adapter } = fixture();
  const broken = createLmStudioModelAdapter({ baseUrl: 'http://localhost:1235/v1',
    modelId: MODEL, fetchImpl: async () => Response.json(metadata),
    sdkClient: { llm: { model: async () => { throw new Error('Unexpected server response: 200'); } } } });
  await assert.rejects(() => broken.verifyRuntime(), (error) => error.code === 'TOKEN_BOUNDS_UNAVAILABLE');
  const payload = adapter.prepareRequest({ role: 'security', prompt, modelId: MODEL, maxOutputTokens: 1024 });
  await assert.rejects(() => broken.countInputTokens({ payload, modelId: MODEL }),
    (error) => error.code === 'TOKEN_BOUNDS_UNAVAILABLE');
});

test('local-only LM Studio adapter rejects public endpoints before any request', () => {
  for (const baseUrl of ['https://models.example.com/v1', 'http://8.8.8.8/v1']) {
    assert.throws(() => createLmStudioModelAdapter({ baseUrl, modelId: MODEL }),
      (error) => error.code === 'INVALID_ADAPTER_CONFIG');
  }
});
