import { createHash, randomUUID } from 'node:crypto';
import { LMStudioClient } from '@lmstudio/sdk';
import { PreflightError } from '../../core/errors.js';

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const TOKEN_MARGIN = 256;
const OUTPUT_INSTRUCTION = 'Review the supplied change and return only JSON matching the response schema. Use only supplied opaque file IDs and valid line ranges. Verdict is recommend-approval when there are no Critical or Required findings; otherwise request-changes. Do not include markdown.';
const FINDING_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
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
    recommendation: { type: 'string' }, confidence: { type: 'number' },
    skill: { type: 'string', enum: ['core-review', 'security-review',
      'performance-review', 'adversarial-input-review'] },
  } });
const RESPONSE_FORMAT = Object.freeze({ type: 'json_schema', json_schema: {
  name: 'triview_review', strict: true,
  schema: { type: 'object', additionalProperties: false, required: ['findings', 'verdict'],
    properties: { findings: { type: 'array', items: FINDING_SCHEMA },
      verdict: { type: 'string', enum: ['recommend-approval', 'request-changes'] } } },
} });

function refuse(code, message) {
  throw new PreflightError(code, message);
}

function baseUrls(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { refuse('INVALID_ADAPTER_CONFIG', 'The LM Studio URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) {
    refuse('INVALID_ADAPTER_CONFIG', 'The LM Studio URL must be an HTTP API base URL.');
  }
  const host = url.hostname.toLowerCase();
  const ipv4 = host.split('.').map(Number);
  const local = host === 'localhost' || host === '[::1]' || /^\[f[cd][a-f0-9:]+\]$/u.test(host)
    || (/^\d+\.\d+\.\d+\.\d+$/u.test(host) && (ipv4[0] === 127 || ipv4[0] === 10
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)));
  if (!local) refuse('INVALID_ADAPTER_CONFIG', 'The local adapter requires localhost or a literal private-network address.');
  return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
}

async function readJson(response, limit) {
  if (!response?.ok || !response.body) refuse('ADAPTER_FAILED', 'The LM Studio API request failed.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) refuse('ADAPTER_FAILED', 'The LM Studio API response exceeded its size limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    refuse('ADAPTER_FAILED', 'The LM Studio API returned invalid or oversized data.');
  } finally {
    reader.releaseLock();
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parsePreparedPayload(payload, modelId) {
  let body;
  try { body = JSON.parse(payload); } catch { refuse('INVALID_ADAPTER_REQUEST', 'The prepared request is invalid.'); }
  if (!body || Object.keys(body).length !== 7 || body.model !== modelId
    || body.stream !== false || body.temperature !== 0
    || body.reasoning_effort !== 'none'
    || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1
    || JSON.stringify(body.response_format) !== JSON.stringify(RESPONSE_FORMAT)
    || !Array.isArray(body.messages) || body.messages.length !== 2
    || JSON.stringify(body.messages[0]) !== JSON.stringify({ role: 'system', content: OUTPUT_INSTRUCTION })
    || body.messages[1]?.role !== 'user' || typeof body.messages[1].content !== 'string'
    || Object.keys(body.messages[1]).length !== 2) {
    refuse('INVALID_ADAPTER_REQUEST', 'The prepared request violates the static review profile.');
  }
  return body;
}

export function createLmStudioModelAdapter({ baseUrl, modelId, apiToken = process.env.LM_API_TOKEN,
  fetchImpl = fetch, sdkClient, maxOutputTokens = 4096 } = {}) {
  const urls = baseUrls(baseUrl);
  if (typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(modelId)
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    refuse('INVALID_ADAPTER_CONFIG', 'A safe loaded model ID and output limit are required.');
  }
  if (apiToken !== undefined && typeof apiToken !== 'string') {
    refuse('INVALID_ADAPTER_CONFIG', 'The LM Studio API token is invalid.');
  }
  const client = sdkClient ?? new LMStudioClient({ baseUrl: urls.ws, apiToken });
  const headers = { 'Content-Type': 'application/json', ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}) };

  async function inspectModel() {
    let document;
    try {
      document = await readJson(await fetchImpl(`${urls.http}/api/v1/models`,
        { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) }), MAX_METADATA_BYTES);
    } catch {
      refuse('ADAPTER_FAILED', 'LM Studio model metadata is unavailable.');
    }
    const model = document?.models?.find((item) => item.key === modelId);
    const loaded = model?.loaded_instances?.find((item) => item.id === modelId);
    const context = loaded?.config?.context_length;
    if (model?.type !== 'llm' || !['gguf', 'mlx'].includes(model?.format)
      || !Number.isSafeInteger(context) || context < 1) {
      refuse('CAPABILITY_UNAVAILABLE', 'The selected local model is not loaded with a known context length.');
    }
    return context;
  }

  async function capabilities({ verifyTokenizer = false } = {}) {
    const context = await inspectModel();
    if (verifyTokenizer) {
      try {
        const model = await client.llm.model(modelId);
        if (await model.getContextLength() !== context) throw new Error('context changed');
        const formatted = await model.applyPromptTemplate([{ role: 'user', content: 'Synthetic token check.' }]);
        const count = await model.countTokens(formatted);
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('no count');
      } catch {
        refuse('TOKEN_BOUNDS_UNAVAILABLE', 'The loaded model tokenizer is unavailable.');
      }
    }
      return { contractVersion: '1.0', adapterId: 'lm-studio-v1', adapterType: 'model',
      adapterVersion: '1.0', providerId: 'lm-studio-local', modelId,
      dataHandling: 'local', contextWindowTokens: context,
      maxOutputTokens: Math.min(maxOutputTokens, context), limitations: [], controls: {
        freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
        structuredOutput: 'enforced', usageReporting: 'enforced',
      } };
  }

  return Object.freeze({
    getCapabilities: () => capabilities(),
    verifyRuntime: () => capabilities({ verifyTokenizer: true }),
    prepareRequest: ({ role, prompt, modelId: requestedModel, maxOutputTokens: outputLimit }) => {
      if (requestedModel !== modelId || !['code-quality', 'security', 'performance'].includes(role)
        || typeof prompt !== 'string' || !Number.isSafeInteger(outputLimit)
        || outputLimit < 1 || outputLimit > maxOutputTokens) {
        refuse('INVALID_ADAPTER_REQUEST', 'The reviewer request does not match the configured model.');
      }
      return JSON.stringify({ model: modelId, messages: [
        { role: 'system', content: OUTPUT_INSTRUCTION }, { role: 'user', content: prompt },
      ], response_format: RESPONSE_FORMAT, temperature: 0, reasoning_effort: 'none',
      max_tokens: outputLimit, stream: false });
    },
    countInputTokens: async ({ payload, modelId: requestedModel }) => {
      if (requestedModel !== modelId || typeof payload !== 'string') {
        refuse('INVALID_ADAPTER_REQUEST', 'The token-count request does not match the model.');
      }
      const body = parsePreparedPayload(payload, modelId);
      try {
        const model = await client.llm.model(modelId);
        const formatted = await model.applyPromptTemplate(body.messages);
        const count = await model.countTokens(formatted);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid count');
        return { upperBound: count + TOKEN_MARGIN, conservative: true };
      } catch {
        refuse('TOKEN_BOUNDS_UNAVAILABLE', 'The loaded model tokenizer could not count the prepared request.');
      }
    },
    invokeReview: async ({ role, invocationId, payload, payloadSha256,
      inputTokenUpperBound, maxOutputTokens: outputLimit, freshContext,
      memoryEnabled, tools, signal }) => {
      if (sha256(payload) !== payloadSha256 || freshContext !== true
        || memoryEnabled !== false || !Array.isArray(tools) || tools.length !== 0
        || !Number.isSafeInteger(inputTokenUpperBound) || inputTokenUpperBound < 0) {
        refuse('INVALID_ADAPTER_REQUEST', 'The reviewer invocation violates the static review profile.');
      }
      const body = parsePreparedPayload(payload, modelId);
      if (body.max_tokens !== outputLimit) {
        refuse('INVALID_ADAPTER_REQUEST', 'The prepared request changed before dispatch.');
      }
      let prompt;
      try { prompt = JSON.parse(body.messages[1].content); } catch {
        refuse('INVALID_ADAPTER_REQUEST', 'The reviewer prompt is invalid.');
      }
      if (prompt.role !== role) refuse('INVALID_ADAPTER_REQUEST', 'The reviewer role changed before dispatch.');
      const context = await inspectModel();
      if (inputTokenUpperBound + outputLimit > context) {
        refuse('BUDGET_EXCEEDED', 'The model context cannot hold the bounded request and output.');
      }
      let response;
      try {
        response = await readJson(await fetchImpl(`${urls.http}/v1/chat/completions`,
          { method: 'POST', headers, body: payload, signal, redirect: 'error' }), MAX_REPLY_BYTES);
      } catch {
        refuse('ADAPTER_FAILED', 'LM Studio reviewer invocation failed.');
      }
      if (response?.model !== modelId || !Array.isArray(response.choices)
        || response.choices.length !== 1 || response.choices[0]?.finish_reason !== 'stop'
        || response.choices[0]?.message?.role !== 'assistant'
        || typeof response.choices[0].message.content !== 'string'
        || (response.choices[0].message.tool_calls?.length ?? 0) !== 0
        || !Number.isSafeInteger(response.usage?.prompt_tokens)
        || response.usage.prompt_tokens > inputTokenUpperBound
        || !Number.isSafeInteger(response.usage?.completion_tokens)
        || response.usage.completion_tokens > outputLimit) {
        refuse('ADAPTER_FAILED', 'LM Studio returned a mismatched or unsafe reviewer response.');
      }
      let generated;
      try { generated = JSON.parse(response.choices[0].message.content); } catch {
        refuse('ADAPTER_FAILED', 'LM Studio did not return a structured reviewer result.');
      }
      return { contractVersion: '1.0', reviewId: prompt.reviewId,
        snapshotSha256: prompt.snapshotSha256, invocationId,
        contextId: `stateless-${randomUUID()}`, reviewer: role,
        adapter: { adapterId: 'lm-studio-v1', providerId: 'lm-studio-local', modelId },
        promptVersion: prompt.promptVersion, skills: prompt.skills.map((item) => item.id),
        status: 'completed', findings: generated.findings, verdict: generated.verdict };
    },
  });
}
