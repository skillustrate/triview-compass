#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'triview-package-check-'));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false,
    timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Package validation command failed.');
  return result.stdout;
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory, '--json']))[0];
  for (const file of packed.files) {
    if (file.path.startsWith('/') || file.path.split('/').includes('..')
      || /^(?:STATE\.md|evals\/results\/|node_modules\/)/u.test(file.path)) throw new Error('Unexpected private artifact in package.');
  }
  const extraction = join(directory, 'extracted');
  await mkdir(extraction);
  run('tar', ['-xzf', join(directory, packed.filename), '-C', extraction, '--no-same-owner']);
  const packageRoot = join(extraction, 'package');
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (['author', 'contributors', 'maintainers'].some(key => Object.hasOwn(metadata, key))) {
    throw new Error('Packaged project metadata must not publish named contributor credits.');
  }
  // Use the already-installed audited dependency tree; this tests packaged assets,
  // not registry resolution. Installation is documented as locked-source npm ci.
  await symlink(join(root, 'node_modules'), join(packageRoot, 'node_modules'));
  const help = run(process.execPath, ['src/cli/review.js', '--help'], packageRoot);
  if (!help.includes('--preflight-only') || !help.includes('--host-context')) throw new Error('Packaged CLI is incomplete.');
  run(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { preflightFiles } from './src/core/preflight.js';
    import { buildReviewerPrompts } from './src/core/prompt-builder.js';
    import { createHostReviewPlan } from './src/integrations/host-review.js';
    import './src/adapters/model/lm-studio.js';
    const policy = JSON.parse(readFileSync('examples/default-policy.json'));
    const bundle = preflightFiles({contractVersion:'1.0', input:{kind:'files', files:[
      {path:'a.js',changeType:'added',content:'export const value = 1;'}]}}, policy);
    const prepared = buildReviewerPrompts(bundle, policy);
    if (Object.keys(prepared.prompts).length !== 3) throw new Error('Missing packaged reviewer assets');
    const context = JSON.parse(readFileSync('examples/host-context.json'));
    const hostPolicy = { ...policy, dataPolicy: { mode: 'local-only', allowedProviders: ['current-provider'] } };
    if (Object.keys(createHostReviewPlan(context, { harnesses: [] }, hostPolicy).routes).length !== 3) {
      throw new Error('Missing packaged host integration');
    }
    if (!readFileSync('skills/triview-review/SKILL.md', 'utf8').includes('name: triview-review')) {
      throw new Error('Missing host review skill');
    }
  `], packageRoot);
  process.stdout.write(`Package validation passed: ${packed.entryCount} files, CLI help, all reviewer/skill/schema assets, both model adapter imports, host selection API and invocation skill. No provider calls.\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
