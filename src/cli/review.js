#!/usr/bin/env node
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createClaudeCodeModelAdapter } from '../adapters/model/claude-code.js';
import { runStaticReview } from '../core/static-review.js';
import { createPodmanSandboxAdapter } from '../adapters/sandbox/podman-runner.js';
import { assertSandboxConfiguration } from '../core/sandbox-config.js';
import { assertReviewPolicy } from '../core/contracts.js';
import { applyPolicyOverrides } from '../core/policy-overrides.js';
import { formatReport } from './format-report.js';
import { createHostReviewPlan, describeHostHarnesses } from '../integrations/host-review.js';
import { CliConfigurationError, createCliModelAdapters, instantiateAdapterModule } from './adapter-loader.js';

export { createCliModelAdapters, instantiateAdapterModule } from './adapter-loader.js';

const OPTIONS = new Set(['--request', '--policy', '--policy-overrides', '--repository', '--harness', '--model',
  '--context-window', '--adapter-module', '--adapter-export', '--adapter-config',
  '--routes', '--host-context', '--review-harnesses', '--review-assignments',
  '--audit-dir', '--retention-days', '--sandbox-config', '--preflight-only', '--format']);

const USAGE = `TriView-Compass review
Usage: node src/cli/review.js --request FILE --policy FILE
  With no runtime selection, a terminal prompts for your harness; CI/piped input must select explicitly.
  --host-context FILE                    Trusted current-harness identity and configured alternatives
                                          (also TRIVIEW_HOST_CONTEXT). With no saved choice, ask which
                                          review harnesses to use; "none" uses the current harness.
  --review-harnesses none|ID[,ID...]       User's answer, passed by the host after asking in chat
  --review-assignments FILE               Reviewer-to-harness ID JSON map for multiple harnesses
  --harness claude-code --model MODEL --context-window TOKENS
                                          Explicitly select the Claude Code reference adapter
  --adapter-module FILE --adapter-export NAME [--adapter-config FILE]
                                          Select any compatible harness through its adapter module.
                                          This CLI has no built-in list of other providers/harnesses
                                          (LM Studio, Codex, Antigravity, anything) by design; write or
                                          reuse an adapter against the contract in adapters/README.md
                                          (examples/adapter-template.js is a starting boilerplate) and
                                          point this flag at it. The exported function is called with
                                          the parsed JSON from --adapter-config (default {}) and must
                                          return an object matching that contract. No IP, host, or
                                          account detail is hard-coded here; it lives entirely in your
                                          own --adapter-config file, which you choose and control.
                                          Use a .mjs extension for FILE (or your own package.json's
                                          "type": "module") so it parses as ESM on every supported
                                          Node version, not only ones new enough to auto-detect it.
  --routes FILE                          Models/accounts/adapters by reviewer role; each role is either
                                          {"kind":"claude-code", ...} or {"kind":"adapter-module",
                                          "module":"...","export":"...","config":{...}} — same generic
                                          loader as --adapter-module, addressed per role
  --policy-overrides FILE                Repo-level overrides layered onto --policy (budgets, path
                                          exclusions, reviewer subset, sandbox opt-in); see
                                          contracts/schemas/policy-overrides.schema.json. The merged
                                          result is still fully schema-validated -- this can only
                                          produce a different valid policy, never an invalid one.
  --repository PATH                      Repository for committed Git input
  --preflight-only true                   Validate without model review or execution
  --format json|text                     Output format (default json)
  --sandbox-config FILE                  Explicit pinned image and command; policy opt-in required
  --audit-dir PATH --retention-days N     Metadata-only audit retention (0 disables, max 3650)
Use a complete policy file to configure provider handling, budgets, exclusions, and reviewer scope.
`;

async function loadModelAdapter(selected) {
  const config = selected['--adapter-config'] === undefined ? {}
    : JSON.parse(await readFile(selected['--adapter-config'], 'utf8'));
  return instantiateAdapterModule(selected['--adapter-module'], selected['--adapter-export'], config);
}

function options(argv, { allowMissingRuntime = false } = {}) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!OPTIONS.has(key) || parsed[key] !== undefined || argv[index + 1] === undefined) {
      throw new CliConfigurationError('Invalid command line arguments.');
    }
    parsed[key] = argv[index + 1];
  }
  if (!parsed['--request'] || !parsed['--policy']
    || (parsed['--audit-dir'] === undefined) !== (parsed['--retention-days'] === undefined)) {
    throw new CliConfigurationError('Request, policy, one runtime selection, and paired audit options are required.');
  }
  const usesBuiltin = parsed['--harness'] !== undefined || parsed['--model'] !== undefined || parsed['--context-window'] !== undefined;
  const usesAdapterModule = parsed['--adapter-module'] !== undefined || parsed['--adapter-export'] !== undefined
    || parsed['--adapter-config'] !== undefined;
  const hostMode = parsed['--host-context'] !== undefined;
  if (!hostMode && (parsed['--review-harnesses'] !== undefined || parsed['--review-assignments'] !== undefined)) {
    throw new CliConfigurationError('Review harness choices require --host-context or TRIVIEW_HOST_CONTEXT.');
  }
  if (hostMode) {
    if (!parsed['--host-context'] || (parsed['--review-assignments'] !== undefined && !parsed['--review-harnesses'])) {
      throw new CliConfigurationError('Host context must name a file; saved assignments require --review-harnesses.');
    }
    if (usesBuiltin || usesAdapterModule || parsed['--routes'] !== undefined) {
      throw new CliConfigurationError('Host selection and direct runtime flags cannot be combined.');
    }
    if (!allowMissingRuntime && !parsed['--review-harnesses']) {
      throw new CliConfigurationError('The host must ask for review harnesses and pass --review-harnesses none or configured IDs; CI never assumes an answer.');
    }
  } else if (parsed['--routes'] !== undefined) {
    if (usesBuiltin || usesAdapterModule) {
      throw new CliConfigurationError('Routes already select a provider per role; single-runtime options are not allowed with them.');
    }
  } else if (usesBuiltin && usesAdapterModule) {
    throw new CliConfigurationError('Choose either the built-in Claude Code runtime or --adapter-module, not both.');
  } else if (usesAdapterModule) {
    if (!parsed['--adapter-module'] || !parsed['--adapter-export']) {
      throw new CliConfigurationError('--adapter-module requires --adapter-export; --adapter-config is optional.');
    }
  } else if (parsed['--harness'] !== 'claude-code' || !parsed['--model'] || !parsed['--context-window']) {
    if (!allowMissingRuntime || usesBuiltin) {
      throw new CliConfigurationError('Choose a harness explicitly: --adapter-module FILE --adapter-export NAME, --routes FILE, or --harness claude-code --model MODEL --context-window TOKENS. Run in a terminal to be asked.');
    }
  }
  if ((parsed['--context-window'] !== undefined
      && !/^[1-9][0-9]*$/u.test(parsed['--context-window']))
    || (parsed['--retention-days'] !== undefined
      && !/^(?:0|[1-9][0-9]*)$/u.test(parsed['--retention-days']))) {
    throw new CliConfigurationError('Invalid numeric option.');
  }
  if ((parsed['--preflight-only'] !== undefined && !['true', 'false'].includes(parsed['--preflight-only']))
    || (parsed['--format'] !== undefined && !['json', 'text'].includes(parsed['--format']))) {
    throw new CliConfigurationError('Preflight-only must be true or false; format must be json or text.');
  }
  return parsed;
}

async function promptForRuntime(input, output) {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  const ask = async (question, optional = false) => {
    for (;;) {
      output.write(`${question} `);
      const { value, done } = await lines.next();
      if (done) throw new CliConfigurationError('Harness selection cancelled before a runtime was selected.');
      const answer = value.trim();
      if (answer.toLowerCase() === 'cancel') throw new CliConfigurationError('Harness selection cancelled.');
      if (answer || optional) return answer;
    }
  };
  try {
    output.write('Choose the harness you want to use. No harness is selected by default.\n'
      + 'Any harness needs a compatible adapter; installed tools are not selected automatically.\n');
    const choice = await ask('Enter an adapter module path, "routes" for a routes file, or "claude-code" for that reference adapter ("cancel" to stop):');
    if (choice.toLowerCase() === 'none') {
      throw new CliConfigurationError('No current-harness integration is configured. Supply --host-context or choose a compatible adapter explicitly.');
    }
    if (choice === 'routes') return ['--routes', await ask('Routes JSON file:')];
    if (choice === 'claude-code') return ['--harness', choice,
      '--model', await ask('Model ID:'), '--context-window', await ask('Context window in tokens:')];
    const selected = ['--adapter-module', choice, '--adapter-export', await ask('Adapter factory export name:')];
    const config = await ask('Adapter config JSON file (blank for {}):', true);
    if (config) selected.push('--adapter-config', config);
    return selected;
  } finally {
    reader.close();
  }
}

async function promptForHostSelection(context, reviewers, input, output) {
  const { currentHarness, currentAvailable, harnesses } = describeHostHarnesses(context);
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  const ask = async (question) => {
    output.write(`${question} `);
    const { value, done } = await lines.next();
    if (done || value.trim().toLowerCase() === 'cancel') {
      throw new CliConfigurationError('Harness selection cancelled.');
    }
    return value.trim();
  };
  try {
    output.write(`Current harness: ${currentHarness}${currentAvailable ? '' : ' (no compatible adapter configured)'}. Each reviewer gets a fresh isolated session.\n`);
    for (const item of harnesses) {
      output.write(`  ${item.id}: ${item.providerId}/${item.modelId} (${item.dataHandling})\n`);
    }
    for (;;) {
      const answer = await ask('Which review harnesses? Enter none or leave blank to use the current harness, or comma-separated IDs (cancel to stop):');
      const ids = !answer || answer.toLowerCase() === 'none' ? [] : answer.split(',').map(id => id.trim());
      if (ids.length > 3 || new Set(ids).size !== ids.length
        || ids.some(id => !harnesses.some(item => item.id === id))) {
        output.write('Choose up to three distinct configured harness IDs.\n');
        continue;
      }
      const selection = { harnesses: ids };
      if (ids.length > 1) {
        selection.assignments = {};
        for (const role of reviewers) {
          let id;
          do { id = await ask(`Harness for ${role} (${ids.join(', ')}):`); } while (!ids.includes(id));
          selection.assignments[role] = id;
        }
        if (ids.some(id => !Object.values(selection.assignments).includes(id))) {
          output.write('Every selected harness must have a reviewer assignment. Choose again.\n');
          continue;
        }
      }
      return selection;
    }
  } finally {
    reader.close();
  }
}

export async function main(argv = process.argv.slice(2), { runReview = runStaticReview,
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  env = process.env, interactive = stdin.isTTY === true && stderr.isTTY === true && !env.CI } = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout.write(USAGE);
    return;
  }
  const directRuntime = ['--harness', '--model', '--context-window', '--adapter-module', '--adapter-export', '--adapter-config', '--routes'];
  if (!argv.includes('--host-context') && !directRuntime.some(flag => argv.includes(flag)) && env.TRIVIEW_HOST_CONTEXT) {
    argv = [...argv, '--host-context', env.TRIVIEW_HOST_CONTEXT];
  }
  let selected = options(argv, { allowMissingRuntime: interactive });
  if (!selected['--harness'] && !selected['--adapter-module'] && !selected['--routes'] && !selected['--host-context']) {
    selected = options([...argv, ...await promptForRuntime(stdin, stderr)]);
  }
  const [request, basePolicy] = await Promise.all([
    readFile(selected['--request'], 'utf8').then(JSON.parse),
    readFile(selected['--policy'], 'utf8').then(JSON.parse),
  ]);
  assertReviewPolicy(basePolicy);
  let policy = selected['--policy-overrides'] === undefined ? basePolicy
    : applyPolicyOverrides(basePolicy, JSON.parse(await readFile(selected['--policy-overrides'], 'utf8')));
  let routeConfig;
  if (selected['--host-context']) {
    const context = JSON.parse(await readFile(selected['--host-context'], 'utf8'));
    const selection = selected['--review-harnesses'] === undefined
      ? await promptForHostSelection(context, policy.reviewers, stdin, stderr)
      : { harnesses: selected['--review-harnesses'] === 'none' ? []
        : selected['--review-harnesses'].split(',').map(id => id.trim()),
        ...(selected['--review-assignments'] === undefined ? {} : {
          assignments: JSON.parse(await readFile(selected['--review-assignments'], 'utf8')),
        }) };
    const plan = createHostReviewPlan(context, selection, policy);
    policy = plan.policy;
    routeConfig = plan.routes;
    for (const [role, id] of Object.entries(plan.assignments)) {
      const route = policy.dataPolicy.roleRoutes[role];
      stderr.write(`Review harness for ${role}: ${id} (${route.providerId}/${route.modelId}).\n`);
    }
  }
  const sandbox = selected['--sandbox-config'] === undefined ? undefined
    : JSON.parse(await readFile(selected['--sandbox-config'], 'utf8'));
  if (sandbox !== undefined) {
    assertSandboxConfiguration(sandbox);
    if (!policy.sandbox.executionRequested) throw new CliConfigurationError('Sandbox configuration requires policy execution opt-in.');
    stderr.write(`Sandbox execution selected: ${JSON.stringify(sandbox)}\n`);
    stderr.write('Scope: included sanitized non-deleted files; source read-only, network disabled.\n');
  }
  if (selected['--routes'] !== undefined) routeConfig = JSON.parse(await readFile(selected['--routes'], 'utf8'));
  const usingAdapterModule = routeConfig === undefined && selected['--adapter-module'] !== undefined;
  // The explicit --harness claude-code path and routes of kind "claude-code"
  // construct a Claude Code adapter, so only those need this hardcoded check.
  // --adapter-module, and routes made entirely of other adapter kinds,
  // intentionally have none: src/core/model-preflight.js already verifies the
  // policy's selectedProvider/allowedProviders generically against whatever
  // providerId the loaded adapter actually declares, for any provider name,
  // with no CLI-side allowlist of known providers.
  const routeUsesClaudeCode = routeConfig !== undefined
    && Object.values(routeConfig).some((route) => route && route.kind === 'claude-code');
  const needsClaudeCodeApproval = routeConfig !== undefined ? routeUsesClaudeCode : !usingAdapterModule;
  if (needsClaudeCodeApproval && (policy.dataPolicy?.mode !== 'approved-hosted'
    || !policy.dataPolicy?.allowedProviders?.includes('anthropic-claude-code'))) {
    throw new CliConfigurationError('The policy must explicitly approve the hosted Claude Code provider.');
  }
  const cwd = await mkdtemp(join(tmpdir(), 'triview-review-'));
  try {
    const modelAdapter = routeConfig !== undefined ? undefined
      : usingAdapterModule ? await loadModelAdapter(selected)
        : createClaudeCodeModelAdapter({ modelId: selected['--model'],
          contextWindowTokens: Number(selected['--context-window']), cwd });
    const modelAdapters = routeConfig === undefined ? undefined
      : await createCliModelAdapters(policy, routeConfig, cwd);
    const audit = selected['--audit-dir'] === undefined ? undefined : {
      directory: selected['--audit-dir'], retentionDays: Number(selected['--retention-days']),
    };
    const report = await runReview({ request, policy,
      repositoryPath: selected['--repository'], modelAdapter, modelAdapters, audit, sandbox,
      preflightOnly: selected['--preflight-only'] === 'true',
      onPreflight: (preflight) => {
        if (selected['--preflight-only'] !== 'true') {
          stderr.write(selected['--format'] === 'text' ? formatReport(preflight) : `Preflight: ${JSON.stringify(preflight)}\n`);
        }
      },
      sandboxAdapter: sandbox === undefined ? undefined : createPodmanSandboxAdapter() });
    stdout.write(selected['--format'] === 'text' ? formatReport(report) : `${JSON.stringify(report, null, 2)}\n`);
    if (['incomplete', 'refused'].includes(report.status)
      || (report.kind === 'preflight' && report.sandbox?.status === 'skipped')) process.exitCode = 2;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// A plain template-literal file:// URL doesn't percent-encode spaces, '#',
// etc. and mishandles Windows paths, so it can silently fail to match
// import.meta.url; pathToFileURL handles both correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Validation and provider errors may contain source in their native text.
    process.stderr.write(error instanceof CliConfigurationError
      ? `INVALID_CLI_CONFIG: ${error.message}\n`
      : `${error?.code ?? 'REVIEW_FAILED'}: Review did not complete.\n`);
    process.exitCode = 1;
  });
}
