#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClaudeCodeModelAdapter } from '../../src/adapters/model/claude-code.js';
import { runStaticReview } from '../../src/core/static-review.js';
import { scoreBehaviorCase } from './score-behavior.js';

// Reference-adapter qualification, not automatic harness selection for reviews.
const allowed = new Set(['--harness', '--model', '--context-window', '--output', '--case', '--inspect']);
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!allowed.has(key) || options[key] !== undefined || process.argv[index + 1] === undefined) {
    throw new Error('Use --harness claude-code --model MODEL --context-window TOKENS --output NEW_FILE [--case ID].');
  }
  options[key] = process.argv[index + 1];
}
if (options['--harness'] !== 'claude-code' || !options['--model'] || !/^[1-9][0-9]*$/u.test(options['--context-window'] ?? '') || !options['--output']) {
  throw new Error('This qualification script requires explicit --harness claude-code, model, context capacity, and a new output file. Use review.js for other adapters.');
}
if (options['--inspect'] !== undefined && !['true', 'false'].includes(options['--inspect'])) throw new Error('Inspect must be true or false.');
const suiteBytes = await readFile(new URL('../behavior/suite.json', import.meta.url));
const suite = JSON.parse(suiteBytes);
const cases = options['--case'] ? suite.cases.filter((item) => item.id === options['--case']) : suite.cases;
if (cases.length === 0) throw new Error('Unknown case.');
const policy = JSON.parse(await readFile(new URL('../../examples/claude-code-policy.json', import.meta.url)));
const guidanceHash = createHash('sha256');
const guidancePaths = [];
for (const folder of ['agents', 'skills/reviewer-briefs']) {
  for (const name of await readdir(new URL(`../../${folder}/`, import.meta.url))) {
    if ((folder === 'agents' && name.endsWith('-reviewer.md')) || (folder !== 'agents' && name.endsWith('.md'))) guidancePaths.push(`${folder}/${name}`);
  }
}
for (const path of guidancePaths.sort()) guidanceHash.update(`${path}\0`).update(await readFile(new URL(`../../${path}`, import.meta.url))).update('\0');
const output = { artifactVersion: '1.0', timestamp: new Date().toISOString(),
  guidanceSha256: guidanceHash.digest('hex'),
  configuredModel: options['--model'], contextWindowAssumption: Number(options['--context-window']),
  cliVersion: execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
  suiteSha256: createHash('sha256').update(suiteBytes).digest('hex'),
  lockSha256: createHash('sha256').update(await readFile(new URL('../../package-lock.json', import.meta.url))).digest('hex'),
  metricNotes: ['Synthetic fixtures only; all reviewed code is inert data.',
    'Anchored keyword matches are advisory quality oracles, not proof of correctness.',
    'Unexpected findings are candidates for manual review, not proven false positives.',
    'CLI reported cost is an API-equivalent estimate, not a subscription charge.',
    'Token metrics are CLI-run totals; preflight bounds apply to each serialized reviewer request.',
    'Baseline uses only code quality; specialty attribution is enforced only for full reviews.',
    'Commit-message and test-output attacks are supplied-file data, not parsed Git/CI metadata.'],
  status: 'running', runs: [] };
// Own this new file before any provider call; never overwrite an existing artifact.
const handle = await open(options['--output'], 'wx', 0o600);
await handle.close();
const cwd = await mkdtemp(join(tmpdir(), 'triview-model-evals-'));
// Synthetic Git fixtures provide real base/target coordinates. Fixture source
// is written as inert data; only trusted Git commands run on the host.
async function fixtureRequest(spec) {
  if (!spec.baseFiles) return { request: { contractVersion: '1.0', input: { kind: 'files', files: spec.files } } };
  const repositoryPath = await mkdtemp(join(tmpdir(), 'triview-eval-git-'));
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', ['-C', repositoryPath, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  const write = async (files) => {
    for (const file of files) {
      if (!/^[A-Za-z0-9._/-]+$/u.test(file.path) || file.path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) throw new Error('Unsafe fixture path.');
      await mkdir(dirname(join(repositoryPath, file.path)), { recursive: true });
      await writeFile(join(repositoryPath, file.path), file.content);
    }
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'Synthetic Evaluation'); git('config', 'user.email', 'eval@example.invalid');
    await write(spec.baseFiles); git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic base');
    const baseRevision = git('rev-parse', 'HEAD');
    await write(spec.files); git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic target');
    return { repositoryPath, request: { contractVersion: '1.0', input: {
      kind: 'git', baseRevision, targetRevision: git('rev-parse', 'HEAD') } } };
  } catch (error) { await rm(repositoryPath, { recursive: true, force: true }); throw error; }
}
try {
  for (const spec of cases) {
    const fixture = await fixtureRequest(spec);
    try {
      for (const baseline of [false, true]) {
        const selected = structuredClone(policy);
        if (baseline) { selected.mode = 'partial'; selected.reviewers = ['code-quality']; selected.budgets.maxModelCalls = 1; }
        const metrics = [];
        const adapter = createClaudeCodeModelAdapter({ modelId: options['--model'], cwd,
          contextWindowTokens: Number(options['--context-window']), onMetrics: (item) => metrics.push(item) });
        const start = performance.now();
        let row;
        try {
          const report = await runStaticReview({ policy: selected,
            ...fixture, modelAdapter: adapter });
          if (options['--inspect'] === 'true') process.stdout.write(`${JSON.stringify({ caseId: spec.id,
            mode: baseline ? 'baseline' : 'full', findings: report.findings, unverifiableFindings: report.unverifiableFindings })}\n`);
          row = { caseId: spec.id, mode: baseline ? 'single-code-quality' : 'three-reviewers',
            reportStatus: report.status, verdict: report.verdict, score: scoreBehaviorCase(spec, report, { baseline }),
            validationFailures: report.unverifiableFindings.map(({ reviewer, reason }) => ({ reviewer, reason })),
            snapshotSha256: report.snapshotSha256, policyVersion: report.preflight.policyVersion,
            promptVersions: report.preflight.promptVersions,
            inputTokenUpperBounds: report.preflight.reviewers.map(({ role, inputTokenUpperBound }) => ({ role, inputTokenUpperBound })),
            metrics: metrics.map(({ invocationId, ...item }) => item) };
        } catch (error) {
          row = { caseId: spec.id, mode: baseline ? 'single-code-quality' : 'three-reviewers',
            reportStatus: 'failed', errorCode: /^[A-Z_]{1,64}$/u.test(error?.code ?? '') ? error.code : 'EVAL_RUN_FAILED',
            score: { passed: false }, metrics: metrics.map(({ invocationId, ...item }) => item) };
        }
        row.latencyMs = Math.round(performance.now() - start);
        output.runs.push(row);
        await writeFile(options['--output'], `${JSON.stringify(output, null, 2)}\n`);
        process.stdout.write(`${row.caseId} ${row.mode}: ${row.score.passed ? 'pass' : 'needs review'} (${row.latencyMs} ms)\n`);
      }
    } finally { if (fixture.repositoryPath) await rm(fixture.repositoryPath, { recursive: true, force: true }); }
  }
  output.status = 'completed';
  output.summary = Object.fromEntries(['three-reviewers', 'single-code-quality'].map((mode) => {
    const rows = output.runs.filter((item) => item.mode === mode);
    return [mode, { runs: rows.length, passed: rows.filter((item) => item.score.passed).length,
      averageLatencyMs: Math.round(rows.reduce((sum, item) => sum + item.latencyMs, 0) / rows.length),
      reportedApiEquivalentUsd: rows.reduce((sum, item) => sum + item.metrics.reduce((total, metric) => total + (metric.estimatedApiEquivalentUsd ?? 0), 0), 0) }];
  }));
  await writeFile(options['--output'], `${JSON.stringify(output, null, 2)}\n`);
  if (output.runs.filter((item) => item.mode === 'three-reviewers').some((item) => !item.score.passed)) process.exitCode = 2;
} finally {
  await rm(cwd, { recursive: true, force: true });
}
