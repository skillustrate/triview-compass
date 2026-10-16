import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excludedPathGlobsFor } from '../evals/scripts/scope-policy.js';

test('excludes every tracked file except the explicit include set', () => {
  const allFiles = ['a.js', 'b.js', 'c/d.js'];
  const result = excludedPathGlobsFor(allFiles, ['b.js']);
  assert.deepEqual(result, ['a.js', 'c/**']);
});

test('collapses a whole excluded directory into one dir/** entry', () => {
  const allFiles = ['src/keep.js', 'vendor/a.js', 'vendor/sub/b.js', 'vendor/sub/deep/c.js'];
  const result = excludedPathGlobsFor(allFiles, ['src/keep.js']);
  assert.deepEqual(result, ['vendor/**']);
});

test('recurses into a directory that contains an included file, excluding only its siblings', () => {
  const allFiles = ['src/keep.js', 'src/other.js', 'src/sub/a.js', 'src/sub/keep2.js'];
  const result = excludedPathGlobsFor(allFiles, ['src/keep.js', 'src/sub/keep2.js']);
  assert.deepEqual(result, ['src/other.js', 'src/sub/a.js']);
});

test('throws for an excluded file that must be individually named because a sibling is included', () => {
  // src/ can't collapse to src/** because src/keep.js is included, so the
  // forbidden-character sibling must be spelled out literally and fails.
  assert.throws(() => excludedPathGlobsFor(['src/keep.js', 'src/file[1].txt'], ['src/keep.js']), /cannot be represented/u);
});

test('does not need to inspect file names inside a wholly-collapsed excluded directory', () => {
  // src/ collapses entirely to src/** since nothing under it is included, so
  // a forbidden character in a filename that's never spelled out is fine.
  const allFiles = ['a.js', 'src/file[1].txt'];
  const result = excludedPathGlobsFor(allFiles, ['a.js']);
  assert.deepEqual(result, ['src/**']);
});

test('throws for an excluded directory name containing a character the glob compiler cannot represent', () => {
  assert.throws(() => excludedPathGlobsFor(['a.js', 'weird[dir]/b.txt'], ['a.js']), /cannot be represented/u);
});

test('rejects an include path that is not in the tree', () => {
  assert.throws(() => excludedPathGlobsFor(['a.js'], ['missing.js']), /not found in the tree/u);
});

test('an empty include list excludes everything at the top level', () => {
  const result = excludedPathGlobsFor(['a.js', 'b.js'], []);
  assert.deepEqual(result, ['a.js', 'b.js']);
});
