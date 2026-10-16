#!/usr/bin/env node
import { chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertReviewPolicy } from '../core/contracts.js';
import { assertSandboxConfiguration } from '../core/sandbox-config.js';
import { orderReviewers, reviewModeFor } from '../core/reviewer-order.js';
import { instantiateAdapterModule } from './review.js';

// Phase 9.0's interactive setup wizard: asks a human yes/no (and a few typed)
// questions and writes the policy/routes/adapter-config files review.js
// already knows how to consume, then prints the exact review.js command to
// run. Explicit runtime flags keep review.js unattended in CI; a terminal
// with no runtime selection asks the user which harness to use.

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const DEFAULT_BUDGETS = Object.freeze({ maxFiles: 50, maxChangedLines: 1000, maxLinesPerFile: 300,
  maxBytesPerFile: 1048576, maxInputTokensPerReviewer: 100000, maxOutputTokensPerReviewer: 2000,
  maxModelCalls: 3, timeoutSeconds: 120 });
const DEFAULT_PATH_POLICY = Object.freeze({ excludedPathGlobs: [],
  generatedPathGlobs: ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/coverage/**'],
  symlinkHandling: 'reject', binaryHandling: 'report-and-skip' });
const DEFAULT_SECRET_POLICY = Object.freeze({ scannerRequired: true,
  sensitivePathGlobs: ['.env', '.env.*', '**/.env', '**/.env.*', '**/.aws/**', '**/.ssh/**',
    '**/.config/gcloud/**', '**/credentials', '**/credentials.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx'],
  onScannerFailure: 'stop-review' });

// readline's question() loses any 'line' event that arrives before the next
// question() call attaches its listener, so pre-written multi-line input
// (as every non-interactive caller, including tests, supplies) can silently
// drop answers. This reader queues complete lines itself instead, so no
// answer is ever lost regardless of when it's asked for.
class LineReader {
  #buffer = '';
  #lines = [];
  #resolvers = [];
  #ended = false;

  constructor(input) {
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      this.#buffer += chunk;
      let index;
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index).replace(/\r$/u, '');
        this.#buffer = this.#buffer.slice(index + 1);
        this.#deliver(line);
      }
    });
    input.on('end', () => { this.#ended = true; this.#deliver(null); });
  }

  #deliver(line) {
    if (this.#resolvers.length > 0) this.#resolvers.shift()(line);
    else this.#lines.push(line);
  }

  next() {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift());
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
}

async function ask(reader, output, question) {
  output.write(`${question} `);
  const line = await reader.next();
  if (line === null) throw new Error('Input ended before the setup finished.');
  return line.trim();
}

async function askYesNo(reader, output, question) {
  for (;;) {
    const answer = (await ask(reader, output, `${question} (yes/no)`)).toLowerCase();
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
  }
}

async function askText(reader, output, question) {
  for (;;) {
    const answer = await ask(reader, output, question);
    if (answer) return answer;
  }
}

// A live review caught that free-typed retention days/directory answers were
// never checked against the exact format review.js itself requires, so a
// wizard-produced command could still fail with INVALID_CLI_CONFIG. Reject
// here instead, with the same rule, before anything is printed or written.
async function askValidated(reader, output, question, isValid, hint) {
  for (;;) {
    const answer = await askText(reader, output, question);
    if (isValid(answer)) return answer;
    output.write(`${hint}\n`);
  }
}

// No named list of assistants: any harness can announce itself generically
// (TRIVIEW_ASSISTANT_*), and this project's own Claude Code adapter is
// recognized the same best-effort way, by the env markers it or its caller
// may have set -- never by asking the user to pick a name from a list.
export async function detectRunningAssistant(env) {
  if (env.TRIVIEW_ASSISTANT_MODULE && env.TRIVIEW_ASSISTANT_EXPORT) {
    return { kind: 'adapter-module', module: env.TRIVIEW_ASSISTANT_MODULE,
      export: env.TRIVIEW_ASSISTANT_EXPORT,
      config: env.TRIVIEW_ASSISTANT_CONFIG ? JSON.parse(env.TRIVIEW_ASSISTANT_CONFIG) : {} };
  }
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT !== undefined) {
    return { kind: 'claude-code', modelId: env.ANTHROPIC_MODEL };
  }
  return null;
}

function dataHandlingFor(assistant) {
  if (assistant.kind === 'claude-code') return 'hosted';
  return assistant.dataHandling === 'local' ? 'local' : 'hosted';
}

async function gatherAssistant(reader, { output, env, detect, loadAdapter, usedClaudeLabels }) {
  const running = await askYesNo(reader, output,
    'Do you want to detect your current harness as a candidate? You will be asked before using it.');
  if (running) {
    const detected = await detect(env);
    if (detected?.kind === 'claude-code'
      && await askYesNo(reader, output, 'Detected Claude Code. Do you want to use this harness?')) {
      const modelId = detected.modelId ?? await askText(reader, output, 'What model is it currently using?');
      let adapterId = 'claude-default';
      if (usedClaudeLabels.size > 0) {
        adapterId = await askText(reader, output,
          'What should we call this account, so we can tell it apart from the others?');
      }
      usedClaudeLabels.add(adapterId);
      return { kind: 'claude-code', modelId, contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, adapterId };
    }
    if (detected?.kind === 'adapter-module'
      && await askYesNo(reader, output, 'Detected an adapter module. Do you want to load and use this harness?')) {
      const adapter = await loadAdapter(detected.module, detected.export, detected.config ?? {});
      const capabilities = await adapter.getCapabilities();
      output.write(`Detected provider "${capabilities.providerId}"`
        + `${capabilities.modelId ? `, model "${capabilities.modelId}"` : ''}.\n`);
      return { kind: 'adapter-module', module: detected.module, export: detected.export,
        config: detected.config ?? {}, providerId: capabilities.providerId,
        modelId: capabilities.modelId, dataHandling: capabilities.dataHandling };
    }
    output.write('No detected harness selected. Choose your adapter below.\n');
  }
  const hasSettingsFile = await askYesNo(reader, output, 'Do you already have a settings file for it?');
  const modulePath = await askText(reader, output, 'What is the path to its adapter module file?');
  const exportName = await askText(reader, output, 'What is the exported setup function called?');
  let config;
  if (hasSettingsFile) {
    const configPath = await askText(reader, output, 'Where is the settings file?');
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } else {
    config = {};
    output.write('Enter its settings one at a time as "key = value". Leave blank when done.\n'
      + '(If any of these are secrets like an API key, they\'ll be written to a file only you can read, '
      + 'but keep that file out of version control.)\n');
    for (;;) {
      const line = await ask(reader, output, '>');
      if (!line) break;
      const splitAt = line.indexOf('=');
      if (splitAt === -1) { output.write('Use the form key = value.\n'); continue; }
      config[line.slice(0, splitAt).trim()] = line.slice(splitAt + 1).trim();
    }
  }
  const adapter = await loadAdapter(modulePath, exportName, config);
  const capabilities = await adapter.getCapabilities();
  output.write(`Detected provider "${capabilities.providerId}"`
    + `${capabilities.modelId ? `, model "${capabilities.modelId}"` : ''}.\n`);
  return { kind: 'adapter-module', module: modulePath, export: exportName, config,
    providerId: capabilities.providerId, modelId: capabilities.modelId, dataHandling: capabilities.dataHandling };
}

export async function runSetup({ input = process.stdin, output = process.stdout, cwd = process.cwd(),
  env = process.env, outputDir, detect = detectRunningAssistant, loadAdapter = instantiateAdapterModule } = {}) {
  const reader = new LineReader(input);
  try {
    const reviewers = [];
    do {
      reviewers.length = 0;
      if (await askYesNo(reader, output, 'Do you want a security review?')) reviewers.push('security');
      if (await askYesNo(reader, output, 'Do you want a performance review?')) reviewers.push('performance');
      if (await askYesNo(reader, output, 'Do you want a code-quality review?')) reviewers.push('code-quality');
      if (reviewers.length === 0) output.write('At least one kind of review is required. Let\'s try again.\n');
    } while (reviewers.length === 0);
    const orderedReviewers = orderReviewers(reviewers);
    const mode = reviewModeFor(orderedReviewers);

    const canSendToServers = await askYesNo(reader, output, 'Is it OK for your code to be sent to an AI model\'s servers?');
    let dataPolicyMode;
    if (!canSendToServers) {
      dataPolicyMode = 'local-only';
    } else {
      const skipModelCalls = await askYesNo(reader, output,
        'Do you want to skip actually calling any AI model for now, and just check that your setup is valid?');
      dataPolicyMode = skipModelCalls ? 'disallow-model-calls' : 'approved-hosted';
    }

    // A runtime selection is still needed even to validate-only (the CLI
    // always needs one), so this is asked regardless of dataPolicyMode; only
    // the written policy's dataPolicy fields differ below.
    const multipleAssistants = await askYesNo(reader, output,
      'Do you want to use more than one AI assistant -- for example a second account, or a different tool -- instead of one assistant for everything?');
    const roleAssistants = {};
    const usedClaudeLabels = new Set();
    let previousAssistant;
    for (const role of orderedReviewers) {
      let assistant;
      if (previousAssistant && !multipleAssistants) {
        assistant = previousAssistant;
      } else if (previousAssistant && multipleAssistants
        && await askYesNo(reader, output, `Do you want to reuse the same assistant for the ${role} review?`)) {
        assistant = previousAssistant;
      } else {
        assistant = await gatherAssistant(reader, { output, env, detect, loadAdapter, usedClaudeLabels });
      }
      roleAssistants[role] = assistant;
      previousAssistant = assistant;
    }

    const wantsSandbox = await askYesNo(reader, output,
      'Do you also want to actually run the code in a sandbox to double-check it, not just read it?');
    let sandboxConfig;
    let sandboxPolicy = { executionRequested: false, backend: 'none', network: 'disabled' };
    if (wantsSandbox) {
      const image = await askText(reader, output, 'What pinned image (registry/name@sha256:...) should it run in?');
      const commandLine = await askText(reader, output, 'What command should it run (space-separated)?');
      sandboxConfig = { image, command: commandLine.split(/\s+/u) };
      assertSandboxConfiguration(sandboxConfig);
      sandboxPolicy = { executionRequested: true, backend: 'podman', network: 'disabled' };
    }

    const wantsAudit = await askYesNo(reader, output,
      'Do you want to keep a record of past reviews (just metadata, never the code itself)?');
    let auditDir;
    let retentionDays;
    if (wantsAudit) {
      auditDir = await askValidated(reader, output,
        'Where should these records be saved (an absolute directory path)?',
        isAbsolute, 'That needs to be an absolute path (it must start with "/").');
      retentionDays = await askValidated(reader, output, 'How many days should they be kept (0 to 3650)?',
        (value) => /^(?:0|[1-9][0-9]*)$/u.test(value) && Number(value) <= 3650,
        'That needs to be a whole number from 0 to 3650, with no extra characters.');
    }

    const allowedProviders = new Set();
    const roleRoutes = {};
    for (const [role, assistant] of Object.entries(roleAssistants)) {
      const providerId = assistant.kind === 'claude-code' ? 'anthropic-claude-code' : assistant.providerId;
      allowedProviders.add(providerId);
      roleRoutes[role] = { providerId, modelId: assistant.modelId ?? 'unspecified',
        adapterId: assistant.adapterId ?? providerId, dataHandling: dataHandlingFor(assistant) };
    }
    const distinctAssistants = new Set(Object.values(roleAssistants).map((assistant) => JSON.stringify(assistant)));
    const usesRoutesFile = distinctAssistants.size > 1;

    // disallow-model-calls forbids selectedProvider/roleRoutes/allowedProviders
    // entirely, even though a runtime selection was still gathered above so
    // the printed command is runnable (it will refuse at MODEL_CALLS_DISABLED,
    // which is the point of a validate-only run).
    const dataPolicy = dataPolicyMode === 'disallow-model-calls'
      ? { mode: dataPolicyMode, allowedProviders: [] }
      : usesRoutesFile
        ? { mode: dataPolicyMode, allowedProviders: [...allowedProviders], roleRoutes }
        : { mode: dataPolicyMode, allowedProviders: [...allowedProviders], selectedProvider: [...allowedProviders][0] };

    const policy = { contractVersion: '1.0', mode, reviewers: orderedReviewers,
      budgets: structuredClone(DEFAULT_BUDGETS), dataPolicy,
      pathPolicy: structuredClone(DEFAULT_PATH_POLICY), secretPolicy: structuredClone(DEFAULT_SECRET_POLICY),
      sandbox: sandboxPolicy };
    assertReviewPolicy(policy);

    // A real live review of this file at an earlier revision (dataPolicyMode
    // === 'local-only' accepted a detected Claude Code assistant, which is
    // always hosted) caught this: answering "no" to sending code to a server
    // must be enforced here, not left to fail confusingly at review time.
    if (dataPolicyMode === 'local-only'
      && Object.values(roleAssistants).some((assistant) => dataHandlingFor(assistant) !== 'local')) {
      output.write('You said your code must stay local, but at least one selected assistant is hosted '
        + '(sends data off this machine). Run the setup again and either answer "yes" to the servers '
        + 'question, or choose only local assistants.\n');
      return { written: false };
    }

    output.write('\nHere is what will be set up:\n');
    output.write(`- Reviews: ${orderedReviewers.join(', ')}\n`);
    output.write(`- Data handling: ${dataPolicyMode}\n`);
    output.write(`- Assistant(s): ${usesRoutesFile ? 'different per role, see below' : 'one, shared by every review'}\n`);
    for (const [role, assistant] of Object.entries(roleAssistants)) {
      const label = assistant.kind === 'claude-code' ? `Claude Code (${assistant.modelId})` : assistant.providerId;
      output.write(`  - ${role}: ${label}\n`);
    }
    output.write(`- Sandbox verification: ${wantsSandbox ? 'yes' : 'no'}\n`);
    output.write(`- Audit records: ${wantsAudit ? `yes, kept ${retentionDays} days` : 'no'}\n`);

    if (!await askYesNo(reader, output, 'Does this look right?')) {
      output.write('Nothing was written. Run the setup again to change your answers.\n');
      return { written: false };
    }

    // Any of these files may hold adapter settings the user typed in,
    // including credentials -- a live review caught that the default mode
    // (typically 0644, world-readable) leaked them to other local accounts
    // and invited accidental commits. 0o700/0o600 restrict both to the
    // owner. mkdir's/writeFile's own `mode` option only takes effect when
    // the path is newly created (confirmed experimentally) -- re-running
    // the wizard into a directory from an earlier, less restrictive run (or
    // one this process didn't create) would silently leave it at its old
    // permissions, so chmod explicitly after the fact regardless of whether
    // the path already existed.
    const directory = outputDir ?? join(cwd, 'triview-setup');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const writeConfigFile = async (path, contents) => {
      await writeFile(path, contents, { mode: 0o600 });
      await chmod(path, 0o600);
    };
    const policyPath = join(directory, 'policy.json');
    await writeConfigFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

    let routesPath;
    if (usesRoutesFile) {
      const routes = Object.fromEntries(Object.entries(roleAssistants).map(([role, assistant]) => [role,
        assistant.kind === 'claude-code'
          ? { kind: 'claude-code', adapterId: assistant.adapterId, modelId: assistant.modelId,
            contextWindowTokens: assistant.contextWindowTokens }
          : { kind: 'adapter-module', module: assistant.module, export: assistant.export, config: assistant.config }]));
      routesPath = join(directory, 'routes.json');
      await writeConfigFile(routesPath, `${JSON.stringify(routes, null, 2)}\n`);
    }

    let sandboxPath;
    if (sandboxConfig) {
      sandboxPath = join(directory, 'sandbox.json');
      await writeConfigFile(sandboxPath, `${JSON.stringify(sandboxConfig, null, 2)}\n`);
    }

    const command = ['node', 'src/cli/review.js', '--request', '<your-request.json>', '--policy', policyPath];
    let adapterConfigPath;
    if (usesRoutesFile) {
      command.push('--routes', routesPath);
    } else {
      const only = Object.values(roleAssistants)[0];
      if (only.kind === 'claude-code') {
        command.push('--harness', 'claude-code', '--model', only.modelId, '--context-window', String(only.contextWindowTokens));
      } else {
        command.push('--adapter-module', only.module, '--adapter-export', only.export);
        // The single-runtime path takes its config from a file, unlike a
        // routes.json entry (which embeds it inline) -- every adapter-module
        // assistant gathered here has a config object, even if empty, and it
        // must reach review.js the same way or the loaded factory silently
        // gets {} instead of what was actually collected.
        adapterConfigPath = join(directory, 'adapter-config.json');
        await writeConfigFile(adapterConfigPath, `${JSON.stringify(only.config, null, 2)}\n`);
        command.push('--adapter-config', adapterConfigPath);
      }
    }
    if (sandboxPath) command.push('--sandbox-config', sandboxPath);
    if (wantsAudit) command.push('--audit-dir', auditDir, '--retention-days', retentionDays);

    // A live review caught that a plain space-join breaks whenever a path or
    // value contains a space or shell metacharacter (a cwd with a space in
    // it, for instance, since the default output directory is under cwd).
    // Single-quoting every argument (escaping embedded single quotes) is
    // paste-and-run safe for POSIX shells regardless of content.
    const shellQuote = (part) => `'${part.replace(/'/gu, "'\\''")}'`;
    output.write(`\nSetup complete. Run:\n${command.map(shellQuote).join(' ')}\n`);
    return { written: true, directory, policyPath, routesPath, sandboxPath, adapterConfigPath, command };
  } finally {
    input.removeAllListeners('data');
    input.removeAllListeners('end');
  }
}

const USAGE = `TriView-Compass setup
Usage: node src/cli/setup.js
Asks a short series of yes/no (and a few typed) questions about how you want
review configured, then writes policy.json (and routes.json/adapter-config
files if needed) to ./triview-setup and prints the review.js command to run.
This never replaces review.js's own flags -- it only generates the files a
human would otherwise hand-write. review.js prompts in a terminal when no
harness is selected; CI requires explicit runtime flags and never prompts.
`;

// A plain template-literal file:// URL doesn't percent-encode spaces, '#',
// etc. and mishandles Windows paths, so it can silently fail to match
// import.meta.url; pathToFileURL handles both correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).includes('--help')) {
    process.stdout.write(USAGE);
  } else {
    runSetup().catch((error) => {
      process.stderr.write(`${error?.message ?? 'Setup failed.'}\n`);
      process.exitCode = 1;
    });
  }
}
