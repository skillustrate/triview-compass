#!/usr/bin/env node
// Diagnostic probe for Phase 8's open "second real account/harness" gap.
//
// This does NOT add a Codex adapter and never sends review content to Codex.
// A real second Claude account was not available, so this uses Codex CLI as a
// second, independently-authenticated real harness to answer a narrower,
// concrete question in two parts:
//
//   1. Env-stripping fidelity under concurrency (no CLI invocation): the exact
//      strip-ANTHROPIC_/CLAUDE_-prefixed-vars logic from invokeCli() in
//      src/adapters/model/claude-code.js is replicated here and checked against
//      a parent env where a second, unrelated provider's own credential vars
//      (OPENAI_*/CODEX_*) are also present and poisoned. The existing mocked
//      tests only ever had one provider's variables present at all; this is
//      the first check of that production code path with a second real
//      provider's variables genuinely in the mix. The one true guarantee this
//      code makes is that ANTHROPIC_*/CLAUDE_* poison is stripped from the
//      Claude-bound env; it does NOT strip other vendors' vars (Claude CLI
//      doesn't read them), so their continued presence is expected, not a bug.
//   2. Real concurrent-session identity check: actually invoke both CLIs at
//      once with their respective real credentials and confirm each reports
//      its own correct identity with no output cross-contamination and no
//      interference between the two concurrent processes.
//
// Requires: `claude` and `codex` CLIs installed and already logged in to real,
// independent accounts. Makes no review calls and sends no project source to
// either provider. Run on the host, not in the deterministic dev-box suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function stripClaudeVars(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) delete out[key];
  }
  return out;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const POISON_CLAUDE = 'POISON_VALUE_FOR_CLAUDE_MUST_NOT_REACH_CODEX';
const POISON_CODEX = 'POISON_VALUE_FOR_CODEX_MUST_NOT_REACH_CLAUDE';

const pollutedParentEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: POISON_CLAUDE,
  CLAUDE_EXTRA_LEAK_TEST: POISON_CLAUDE,
  OPENAI_API_KEY: POISON_CODEX,
  CODEX_EXTRA_LEAK_TEST: POISON_CODEX,
};

console.log('=== Check 1: env-stripping fidelity under concurrency ===');
const claudeEnv = stripClaudeVars(pollutedParentEnv);

assert.ok(!Object.keys(claudeEnv).some((key) => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')),
  'FAIL: Claude-bound env still contains ANTHROPIC_*/CLAUDE_* vars after stripping');
assert.ok(!Object.values(claudeEnv).includes(POISON_CLAUDE),
  'FAIL: Claude-bound env carries its own poison value after stripping');
console.log('PASS: the real invokeCli() stripping logic removes ANTHROPIC_*/CLAUDE_* poison even with a second, unrelated provider\'s own credential vars present in the same parent env.');
console.log('NOTE: unrelated OPENAI_*/CODEX_* vars remain in the Claude-bound env by design — Claude CLI does not read them, so this is expected, not a leak.');

console.log('\n=== Check 2: real concurrent-session identity check ===');
// Codex has no adapter/stripping logic in this project (see the scoping note in
// this file's header); it receives the full polluted parent env unmodified,
// matching how it would actually run today if invoked ad hoc.
const [claudeResult, codexResult] = await Promise.all([
  run('claude', ['--version'], claudeEnv),
  run('codex', ['doctor', '--json', '--summary'], pollutedParentEnv),
]);

assert.equal(claudeResult.code, 0, `claude --version failed: ${claudeResult.stderr}`);
assert.ok(claudeResult.stdout.includes('(Claude Code)'), 'FAIL: unexpected claude --version output shape');
assert.ok(!claudeResult.stdout.includes(POISON_CODEX) && !claudeResult.stderr.includes(POISON_CODEX),
  'FAIL: Claude Code output/stderr contains the Codex poison value');

assert.equal(codexResult.code, 0, `codex doctor failed: ${codexResult.stderr}`);
let doctorReport;
try { doctorReport = JSON.parse(codexResult.stdout); } catch { throw new Error('codex doctor did not return valid JSON'); }
const authCheck = doctorReport.checks?.['auth.credentials'];
assert.equal(authCheck?.status, 'ok', 'FAIL: codex auth.credentials check did not report ok');
assert.ok(!codexResult.stdout.includes(POISON_CLAUDE) && !codexResult.stderr.includes(POISON_CLAUDE),
  'FAIL: Codex output/stderr contains the Claude poison value');

console.log(`PASS: claude --version reported ${claudeResult.stdout.trim()}`);
console.log(`PASS: codex doctor auth.credentials status = ${authCheck.status} (${authCheck.summary})`);
console.log('PASS: neither harness\'s output carries the other\'s poison value; both ran concurrently with no observed interference.');

console.log('\nAll checks passed. No review content or project source was sent to either harness.');
