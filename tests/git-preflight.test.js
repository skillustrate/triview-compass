import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { preflightGit } from '../src/core/git-capture.js';
import { buildReviewerPrompts } from '../src/core/prompt-builder.js';

const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function repository() {
  const repo = mkdtempSync(join(tmpdir(), 'review-git-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Synthetic Test');
  git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  return repo;
}

function write(repo, path, content) {
  const fullPath = join(repo, path);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function commit(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function request(baseRevision, targetRevision) {
  return { contractVersion: '1.0', input: { kind: 'git', baseRevision, targetRevision } };
}

test('captures committed content, excludes sensitive files, and skips binary content', () => {
  const repo = repository();
  try {
    const longFile = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n';
    write(repo, 'src/app.js', longFile);
    write(repo, '.env', 'BASE_PRIVATE_VALUE\n');
    const base = commit(repo, 'base');
    const credential = 'AKIAABCDEFGHIJKLMNOP';
    write(repo, 'src/app.js', longFile.replace('line 399', `const key = '${credential}'`));
    write(repo, '.env', 'TARGET_PRIVATE_VALUE\n');
    write(repo, 'data.bin', Buffer.from([0, 1, 2]));
    write(repo, 'dist/out.js', 'GENERATED_VALUE\n');
    const target = commit(repo, 'target');
    write(repo, 'src/app.js', 'WORKTREE_SHOULD_NOT_APPEAR\n');

    const bundle = preflightGit(request(base, target), policy, { repositoryPath: repo });
    const source = bundle.files.find((item) => item.path === 'src/app.js');
    const sensitive = bundle.files.find((item) => item.path === '.env');
    const binary = bundle.files.find((item) => item.path === 'data.bin');
    const generated = bundle.files.find((item) => item.path === 'dist/out.js');
    assert.equal(bundle.snapshot.inputKind, 'git');
    assert.equal(Object.isFrozen(bundle), true);
    assert.equal(Object.isFrozen(bundle.files[0]), true);
    assert.equal(bundle.snapshot.baseRevision, base);
    assert.equal(bundle.snapshot.targetRevision, target);
    assert.equal(source.state, 'included');
    assert.match(source.content, /\[REDACTED: credential\]/);
    assert.equal(sensitive.state, 'excluded');
    assert.equal(binary.state, 'binary');
    assert.equal('content' in binary, false);
    assert.equal(generated.state, 'generated');
    assert.equal('content' in generated, false);
    const serialized = JSON.stringify(bundle);
    for (const value of [credential, 'TARGET_PRIVATE_VALUE', 'GENERATED_VALUE', 'WORKTREE_SHOULD_NOT_APPEAR']) {
      assert.equal(serialized.includes(value), false);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects a target that does not descend from the base', () => {
  const repo = repository();
  try {
    write(repo, 'src/app.js', 'one\n');
    const base = commit(repo, 'base');
    write(repo, 'src/app.js', 'two\n');
    const target = commit(repo, 'target');
    assert.throws(() => preflightGit(request(target, base), policy, { repositoryPath: repo }),
      (error) => error.code === 'INVALID_REVISION');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects symlinks before reading a changed blob', () => {
  const repo = repository();
  try {
    write(repo, 'src/app.js', 'base\n');
    const base = commit(repo, 'base');
    symlinkSync('../outside', join(repo, 'link'));
    const target = commit(repo, 'target');
    assert.throws(() => preflightGit(request(base, target), policy, { repositoryPath: repo }),
      (error) => error.code === 'UNSUPPORTED_FILE');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a Git rename from a sensitive path remains excluded', () => {
  const repo = repository();
  try {
    write(repo, '.env', 'UNKNOWN_PRIVATE_VALUE\n');
    const base = commit(repo, 'base');
    mkdirSync(join(repo, 'src'), { recursive: true });
    renameSync(join(repo, '.env'), join(repo, 'src', 'moved.js'));
    const target = commit(repo, 'target');
    const bundle = preflightGit(request(base, target), policy, { repositoryPath: repo });
    const moved = bundle.files.find((entry) => entry.path === 'src/moved.js');
    assert.equal(moved.changeType, 'renamed');
    assert.equal(moved.previousPath, '.env');
    assert.equal(moved.state, 'excluded');
    assert.equal(JSON.stringify(bundle).includes('UNKNOWN_PRIVATE_VALUE'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects a committed blob above the configured byte limit', () => {
  const repo = repository();
  try {
    write(repo, 'src/a.js', 'a\n');
    const base = commit(repo, 'base');
    write(repo, 'src/a.js', '12345\n');
    const target = commit(repo, 'target');
    const tight = structuredClone(policy);
    tight.budgets.maxBytesPerFile = 4;
    assert.throws(() => preflightGit(request(base, target), tight, { repositoryPath: repo }),
      (error) => error.code === 'BUDGET_EXCEEDED');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a stalled Git command times out without returning captured content', () => {
  const bin = mkdtempSync(join(tmpdir(), 'review-slow-git-'));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 3\n');
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const tight = structuredClone(policy);
    tight.budgets.timeoutSeconds = 1;
    const base = 'a'.repeat(40);
    const target = 'b'.repeat(40);
    assert.throws(() => preflightGit(request(base, target), tight, { repositoryPath: bin }),
      (error) => error.code === 'CAPTURE_TIMEOUT');
  } finally {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test('missing partial-clone objects refuse without invoking a lazy-fetch transport', () => {
  const repo = repository();
  try {
    write(repo, 'a.js', 'const value = 1;\n');
    const base = commit(repo, 'base');
    write(repo, 'a.js', 'const value = 2;\n');
    const target = commit(repo, 'target');
    const oid = git(repo, 'rev-parse', `${target}:a.js`);
    const marker = join(repo, 'fetch-was-invoked');
    const transport = join(repo, 'upload-pack-test');
    writeFileSync(transport, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(transport, 0o700);
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'remote.origin.url', repo);
    git(repo, 'config', 'remote.origin.uploadpack', transport);
    rmSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    assert.throws(() => preflightGit(request(base, target), policy, { repositoryPath: repo }),
      (error) => error.code === 'GIT_CAPTURE_FAILED');
    assert.equal(existsSync(marker), false);
    // Positive control: the same missing object does invoke the configured
    // local transport when the no-lazy-fetch safeguard is deliberately absent.
    assert.throws(() => execFileSync('git', ['-C', repo, 'cat-file', '-s', oid], {
      env: { ...process.env, GIT_NO_LAZY_FETCH: '0' }, stdio: 'pipe', timeout: 5000,
    }));
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Git prompts expose numeric changed-line context without old source or excluded data', () => {
  const repo = repository();
  try {
    write(repo, 'modified.js', 'const old = "BASE_ONLY_PRIVATE";\nkeep();\nremove();\n');
    write(repo, 'deleted.js', 'gone();\n');
    write(repo, 'renamed.js', 'same();\n');
    const base = commit(repo, 'base');
    write(repo, 'modified.js', 'const next = 2;\nkeep();\n');
    write(repo, 'added.js', 'newCode();\n');
    rmSync(join(repo, 'deleted.js'));
    renameSync(join(repo, 'renamed.js'), join(repo, 'new-name.js'));
    write(repo, '.env', 'EXCLUDED_PRIVATE\n');
    const target = commit(repo, 'target');
    const bundle = preflightGit(request(base, target), policy, { repositoryPath: repo });
    const contexts = Object.fromEntries(bundle.files.filter((file) => file.state === 'included')
      .map((file) => [file.path, file.changeContext]));
    assert.deepEqual(contexts['modified.js'], { status: 'available', basis: 'target', hunks: [
      { baseStart: 1, baseCount: 1, targetStart: 1, targetCount: 1 },
      { baseStart: 3, baseCount: 1, targetStart: 2, targetCount: 0 },
    ] });
    assert.deepEqual(contexts['added.js'].hunks, [{ baseStart: 0, baseCount: 0, targetStart: 1, targetCount: 1 }]);
    assert.equal(contexts['deleted.js'].basis, 'base');
    assert.deepEqual(contexts['new-name.js'].hunks, []);
    assert.equal(Object.isFrozen(contexts['modified.js'].hunks[0]), true);
    const prompt = buildReviewerPrompts(bundle, policy).prompts['code-quality'];
    for (const value of ['BASE_ONLY_PRIVATE', 'EXCLUDED_PRIVATE', 'modified.js', 'new-name.js']) assert.equal(prompt.includes(value), false);
    assert.ok(prompt.includes('1 | const next = 2;'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('redacted Git files withhold hunk coordinates instead of mapping original lines to sanitized lines', () => {
  const repo = repository();
  try {
    write(repo, 'key.txt', 'before\n');
    const base = commit(repo, 'base');
    write(repo, 'key.txt', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_VALUE\n-----END PRIVATE KEY-----\nafter\n');
    const target = commit(repo, 'target');
    const bundle = preflightGit(request(base, target), policy, { repositoryPath: repo });
    assert.deepEqual(bundle.files[0].changeContext, { status: 'unavailable', basis: 'target', hunks: [] });
    const prompt = JSON.parse(buildReviewerPrompts(bundle, policy).prompts.security);
    assert.equal(prompt.files[0].lineCount, 2);
    assert.equal(prompt.files[0].content.includes('SYNTHETIC_VALUE'), false);
    assert.ok(prompt.files[0].content.startsWith('1 | [REDACTED: private-key]'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
