import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { PreflightError } from '../../core/errors.js';

const PROVIDER_ID = 'anthropic-claude-code';
const ADAPTER_ID = 'claude-code-v1';
const SUPPORTED_CLI_VERSION = '2.1.300';
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
// Reserve for CLI protocol and system text that is not present in the prompt.
// The configurable context limit must leave this entire reserve unused.
const PROTOCOL_RESERVE_TOKENS = 65536;
const RESPONSE_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['findings', 'verdict'], properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'category', 'severity', 'title', 'impact', 'evidence', 'confidence', 'skill'],
      properties: {
        id: { type: 'string' },
        category: { type: 'string', enum: ['correctness', 'security', 'performance',
          'maintainability', 'architecture', 'testing', 'privacy', 'supply-chain', 'reliability', 'other'] },
        severity: { type: 'string', enum: ['Critical', 'Required', 'Optional', 'Nit'] },
        title: { type: 'string' }, impact: { type: 'string' },
        evidence: { type: 'object', additionalProperties: false,
          required: ['path', 'startLine', 'endLine'], properties: {
            path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' },
          } },
        recommendation: { type: 'string' }, confidence: { type: 'number' }, skill: { type: 'string' },
      } } },
    verdict: { type: 'string', enum: ['recommend-approval', 'request-changes'] },
  } };

function refuse(code = 'ADAPTER_FAILED') {
  throw new PreflightError(code, 'The Claude Code adapter could not enforce its review profile.');
}

function parsePayload(payload, modelId) {
  let data;
  try { data = JSON.parse(payload); } catch { refuse('INVALID_ADAPTER_REQUEST'); }
  if (!data || Object.keys(data).length !== 4 || data.modelId !== modelId
    || !['code-quality', 'security', 'performance'].includes(data.role)
    || typeof data.prompt !== 'string' || data.prompt.length === 0
    || !Number.isSafeInteger(data.maxOutputTokens) || data.maxOutputTokens < 1) {
    refuse('INVALID_ADAPTER_REQUEST');
  }
  return data;
}

function responseSchema(prompt) {
  const schema = structuredClone(RESPONSE_SCHEMA);
  if (!Array.isArray(prompt.files) || !Array.isArray(prompt.skills)) refuse('INVALID_ADAPTER_REQUEST');
  const anchors = prompt.files.filter((file) => Number.isSafeInteger(file.lineCount) && file.lineCount > 0)
    .map((file) => ({ type: 'object', additionalProperties: false,
      required: ['path', 'startLine', 'endLine'], properties: {
        path: { const: file.path },
        startLine: { type: 'integer', minimum: 1, maximum: file.lineCount },
        endLine: { type: 'integer', minimum: 1, maximum: file.lineCount },
      } }));
  if (anchors.length === 0) schema.properties.findings.maxItems = 0;
  else schema.properties.findings.items.properties.evidence = { oneOf: anchors };
  schema.properties.findings.items.properties.skill = { type: 'string', enum: prompt.skills.map((skill) => skill.id) };
  return schema;
}

async function invokeCli(command, args, input, { spawnImpl, signal, cwd, outputLimit, configDir, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(outputLimit) };
      for (const key of Object.keys(env)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) delete env[key];
      }
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(outputLimit);
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
      child = spawnImpl(command, args, { cwd, signal, shell: false, env, killSignal: 'SIGKILL',
        stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { reject(new Error('spawn failed')); return; }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    child.on('error', () => finish(new Error('spawn failed')));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES) { finish(new Error('oversized reply')); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    // stderr can contain provider text or secrets. Never retain or forward it.
    child.stderr.resume();
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) finish(new Error('CLI failed'));
      else finish(null, Buffer.concat(chunks, bytes).toString('utf8'));
    });
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      finish(new Error('CLI timeout'));
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function createClaudeCodeModelAdapter({ command = 'claude', modelId,
  adapterId = ADAPTER_ID, configDir, contextWindowTokens,
  maxOutputTokens = 4096, cwd, spawnImpl = spawn, authCheck, onMetrics } = {}) {
  configDir ??= process.env.CLAUDE_CONFIG_DIR;
  if (typeof command !== 'string' || !/^(?:claude|\/[A-Za-z0-9/._+-]+)$/u.test(command)
    || typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(modelId)
    || !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens <= PROTOCOL_RESERVE_TOKENS
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
    || maxOutputTokens >= contextWindowTokens - PROTOCOL_RESERVE_TOKENS
    || typeof cwd !== 'string' || !isAbsolute(cwd)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(adapterId)
    || (configDir !== undefined && (typeof configDir !== 'string' || !isAbsolute(configDir)))) {
    refuse('INVALID_ADAPTER_CONFIG');
  }
  const capabilities = Object.freeze({ contractVersion: '1.0', adapterId,
    adapterType: 'model', adapterVersion: '1.0', providerId: PROVIDER_ID,
    modelId, dataHandling: 'hosted', contextWindowTokens,
    maxOutputTokens, limitations: [
      'CLI token usage is unavailable before invocation; a large fixed protocol reserve is used.',
      'Model identity is the configured CLI selection; exact served model identity is unverified.',
      'Context capacity and protocol reserve are caller-configured assumptions.',
    ],
    controls: { freshContextPerReviewer: 'enforced', crossSessionMemoryDisabled: 'enforced',
      structuredOutput: 'enforced', usageReporting: 'unsupported' } });
  async function verifySubscription({ signal } = {}) {
    let status;
    try {
      const version = await invokeCli(command, ['--version'], '',
        { spawnImpl, cwd, configDir, outputLimit: 1, signal, timeoutMs: 10000 });
      if (!version.startsWith(`${SUPPORTED_CLI_VERSION} (Claude Code)`)) refuse('CAPABILITY_UNAVAILABLE');
      status = authCheck ? await authCheck({ signal }) : JSON.parse(await invokeCli(command,
        ['auth', 'status'], '', { spawnImpl, cwd, configDir, outputLimit: 1, signal, timeoutMs: 10000 }));
    } catch { refuse('CAPABILITY_UNAVAILABLE'); }
    if (status?.loggedIn !== true || status.authMethod !== 'claude.ai'
      || status.apiProvider !== 'firstParty'
      || typeof status.subscriptionType !== 'string' || status.subscriptionType.length === 0) {
      refuse('CAPABILITY_UNAVAILABLE');
    }
    return capabilities;
  }
  return Object.freeze({
    getCapabilities: () => capabilities,
    verifyRuntime: verifySubscription,
    prepareRequest: ({ role, prompt, modelId: requestedModel, maxOutputTokens: outputLimit }) => {
      if (requestedModel !== modelId || !['code-quality', 'security', 'performance'].includes(role)
        || typeof prompt !== 'string' || !Number.isSafeInteger(outputLimit)
        || outputLimit < 1 || outputLimit > maxOutputTokens) refuse('INVALID_ADAPTER_REQUEST');
      return JSON.stringify({ role, prompt, modelId, maxOutputTokens: outputLimit });
    },
    countInputTokens: ({ payload, modelId: requestedModel }) => {
      if (requestedModel !== modelId || typeof payload !== 'string') refuse('INVALID_ADAPTER_REQUEST');
      parsePayload(payload, modelId);
      // A UTF-8 byte can encode at most one ordinary text token. The reserve
      // covers CLI framing and fixed system instructions outside this payload.
      return { upperBound: Buffer.byteLength(payload) + PROTOCOL_RESERVE_TOKENS, conservative: true };
    },
    invokeReview: async ({ role, invocationId, payload, payloadSha256,
      inputTokenUpperBound, maxOutputTokens: outputLimit, freshContext,
      memoryEnabled, tools, signal }) => {
      if (createHash('sha256').update(payload).digest('hex') !== payloadSha256
        || freshContext !== true || memoryEnabled !== false || !Array.isArray(tools)
        || tools.length !== 0) refuse('INVALID_ADAPTER_REQUEST');
      const data = parsePayload(payload, modelId);
      if (data.role !== role || data.maxOutputTokens !== outputLimit
        || Buffer.byteLength(payload) + PROTOCOL_RESERVE_TOKENS > inputTokenUpperBound
        || inputTokenUpperBound + outputLimit > contextWindowTokens) refuse('INVALID_ADAPTER_REQUEST');
      let prompt;
      try { prompt = JSON.parse(data.prompt); } catch { refuse('INVALID_ADAPTER_REQUEST'); }
      if (prompt.role !== role) refuse('INVALID_ADAPTER_REQUEST');
      const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(responseSchema(prompt)),
        '--model', modelId, '--safe-mode', '--restricted', '--tools', '',
        '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--no-session-persistence', '--strict-mcp-config',
        '--system-prompt', 'Return only the requested code review JSON. Do not use tools.'];
      let response;
      try {
        response = JSON.parse(await invokeCli(command, args, data.prompt,
          { spawnImpl, signal, cwd, outputLimit, configDir }));
      } catch { refuse(); }
      if (response?.is_error !== false || typeof response.session_id !== 'string'
        || !/^[A-Za-z0-9._:@+-]+$/u.test(response.session_id)) refuse();
      if (response.usage !== undefined) {
        const values = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
          .map((field) => response.usage[field]);
        if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
          || values[0] + values[1] + values[2] > inputTokenUpperBound || values[3] > outputLimit) {
          refuse('BUDGET_EXCEEDED');
        }
      }
      let generated = response.structured_output;
      if (generated === undefined) {
        try { generated = JSON.parse(response.result); } catch { refuse(); }
      }
      if (!generated || typeof generated !== 'object' || Array.isArray(generated)) refuse();
      if (onMetrics !== undefined) {
        const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
        const usage = response.usage;
        const input = [usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens].map(count);
        onMetrics({ role, invocationId,
          reportedInputTokens: input.every((value) => value !== null) ? input.reduce((sum, value) => sum + value, 0) : null,
          reportedOutputTokens: count(usage?.output_tokens),
          estimatedApiEquivalentUsd: Number.isFinite(response.total_cost_usd) && response.total_cost_usd >= 0 ? response.total_cost_usd : null,
          observedModels: Object.keys(response.modelUsage ?? {}).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(name)),
        });
      }
      return { contractVersion: '1.0', reviewId: prompt.reviewId,
        snapshotSha256: prompt.snapshotSha256, invocationId,
        contextId: response.session_id, reviewer: role,
        adapter: { adapterId, providerId: PROVIDER_ID, modelId },
        promptVersion: prompt.promptVersion, skills: prompt.skills.map((item) => item.id),
        status: 'completed', findings: generated.findings, verdict: generated.verdict };
    },
  });
}
