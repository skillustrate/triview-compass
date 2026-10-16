import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preflightFiles } from '../src/core/preflight.js';

const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));
const request = (files) => ({ contractVersion: '1.0', input: { kind: 'files', files } });
const file = (path, content, changeType = 'modified') => ({ path, content, changeType });

test('redacts a known credential before the bundle can leave preflight', () => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const result = preflightFiles(request([file('src/app.js', `const key = '${secret}';\n`)]), policy);
  assert.equal(result.files[0].state, 'included');
  assert.match(result.files[0].content, /\[REDACTED: credential\]/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('excludes sensitive paths without including their contents', () => {
  const secret = 'SENSITIVE_VALUE_FOR_EVAL';
  const result = preflightFiles(request([file('.env', secret), file('src/app.js', 'export {};\n')]), policy);
  const excluded = result.files.find((entry) => entry.path === '.env');
  assert.equal(excluded.state, 'excluded');
  assert.equal('content' in excluded, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('rejects traversal and duplicate paths without echoing source', () => {
  const secret = 'PRIVATE_EVAL_VALUE';
  for (const files of [
    [file('../outside.js', secret)],
    [file('src/a.js', secret), file('src/a.js', secret)],
  ]) {
    assert.throws(() => preflightFiles(request(files), policy), (error) => {
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('rejects file and changed-line budget overflow without truncation', () => {
  const tight = structuredClone(policy);
  tight.budgets.maxFiles = 1;
  assert.throws(() => preflightFiles(request([file('a.js', 'a'), file('b.js', 'b')]), tight), /BUDGET_EXCEEDED/);
  tight.budgets.maxFiles = 2;
  tight.budgets.maxChangedLines = 1;
  assert.throws(() => preflightFiles(request([file('a.js', 'a\nb\n')]), tight), /BUDGET_EXCEEDED/);
});

test('rejects oversized supplied text before scanning', () => {
  const tight = structuredClone(policy);
  tight.budgets.maxBytesPerFile = 4;
  assert.throws(() => preflightFiles(request([file('src/a.js', '12345')]), tight),
    (error) => error.code === 'BUDGET_EXCEEDED');
});

test('scanner failure stops preflight and does not expose source', () => {
  const secret = 'PRIVATE_EVAL_VALUE';
  assert.throws(
    () => preflightFiles(request([file('src/a.js', secret)]), policy, { scan: () => { throw new Error(secret); } }),
    (error) => error.code === 'SCANNER_FAILED' && !error.message.includes(secret),
  );
});

test('a stalled trusted scanner times out without returning a bundle or source', () => {
  const tight = structuredClone(policy);
  tight.budgets.timeoutSeconds = 1;
  const secret = 'PRIVATE_EVAL_VALUE';
  assert.throws(
    () => preflightFiles(request([file('src/a.js', secret)]), tight,
      { scan: () => { while (true) { /* simulate a stalled scanner */ } } }),
    (error) => error.code === 'SCANNER_TIMEOUT' && !error.message.includes(secret),
  );
});

test('a rename from a sensitive path remains excluded', () => {
  const secret = 'SENSITIVE_VALUE_FOR_EVAL';
  const renamed = { ...file('src/moved.js', secret, 'renamed'), previousPath: '.env' };
  const result = preflightFiles(request([renamed]), policy);
  assert.equal(result.files[0].state, 'excluded');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('invalid scanner spans fail closed', () => {
  assert.throws(
    () => preflightFiles(request([file('src/a.js', 'secret')]), policy,
      { scan: () => [{ start: 2, end: 9, kind: 'credential' }] }),
    (error) => error.code === 'SCANNER_FAILED',
  );
});

test('snapshot identity is stable across file ordering and every full role is present', () => {
  const files = [file('b.js', 'b\n'), file('a.js', 'a\n')];
  const first = preflightFiles(request(files), policy);
  const second = preflightFiles(request([...files].reverse()), policy);
  assert.equal(first.snapshot.sha256, second.snapshot.sha256);
  assert.deepEqual(first.reviewers, ['code-quality', 'security', 'performance']);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.files[0]), true);
});
