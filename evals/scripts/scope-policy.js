#!/usr/bin/env node
// Generates `pathPolicy.excludedPathGlobs` for a real-change corpus case by
// listing every file at the target revision and excluding everything except
// the explicitly included set. Hand-maintained exclude lists (as used by the
// first git-capture pilot) silently under-exclude when the tree gains files
// after the list was written; this derives the list from the actual tree
// instead, so a case's scope cannot drift without the generator being rerun.
//
// Output globs are collapsed to whole-subtree `dir/**` entries wherever a
// directory contains no included path, instead of one literal entry per
// file. This keeps the generated policy small even for large real-world
// trees (a naive per-file list hit 1.7MB / 18,000+ entries against
// jackson-databind's tree). preflight.js's glob compiler (src/core/
// preflight.js:compileGlob) refuses any glob containing `?{}[]` or a
// backslash, with no escape mechanism - so a path containing one of those
// characters cannot be expressed as an exclude glob at all, literal or
// escaped. Rather than silently emit a glob that would later be refused
// with a confusing INVALID_POLICY, this throws naming the offending path.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OPTIONS = new Set(['--repository', '--revision', '--include', '--out']);
const FORBIDDEN_CHARACTERS = /[?{}[\]\\]/u;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { include: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!OPTIONS.has(key)) throw new UsageError(`Unknown option: ${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`Missing value for ${key}`);
    i += 1;
    if (key === '--include') args.include.push(value);
    else args[key.slice(2)] = value;
  }
  if (!args.repository || !args.revision || args.include.length === 0) {
    throw new UsageError('Usage: scope-policy.js --repository PATH --revision SHA --include PATH [--include PATH ...] [--out FILE]');
  }
  return args;
}

export function listTrackedFiles(repository, revision) {
  const output = execFileSync('git', ['-C', repository, 'ls-tree', '-r', '--name-only', revision], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\n').filter((line) => line.length > 0);
}

function assertRepresentable(path) {
  if (FORBIDDEN_CHARACTERS.test(path) || path.length > 256) {
    throw new Error(`Path cannot be represented as a supported exclude glob (contains '?{}[]\\' or exceeds 256 characters): ${path}`);
  }
}

// Builds a directory tree of { files: Set<string> (basenames), dirs: Map<string, node> }
// so whole subtrees with no included path can collapse to one `dir/**` entry.
function buildTree(paths) {
  const root = { files: new Set(), dirs: new Map() };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Set(), dirs: new Map() });
      node = node.dirs.get(part);
    }
    node.files.add(parts[parts.length - 1]);
  }
  return root;
}

function markIncluded(root, includedFiles) {
  const includedDirs = new Set(['']);
  for (const path of includedFiles) {
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      includedDirs.add(prefix);
    }
  }
  return includedDirs;
}

function collectExcludes(node, prefix, includedDirs, includedFiles, globs) {
  for (const name of [...node.dirs.keys()].sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (includedDirs.has(path)) {
      collectExcludes(node.dirs.get(name), path, includedDirs, includedFiles, globs);
    } else {
      assertRepresentable(path);
      globs.push(`${path}/**`);
    }
  }
  for (const name of [...node.files].sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!includedFiles.has(path)) {
      assertRepresentable(path);
      globs.push(path);
    }
  }
}

export function excludedPathGlobsFor(allFiles, includedFiles) {
  const included = new Set(includedFiles);
  const missing = includedFiles.filter((path) => !allFiles.includes(path));
  if (missing.length > 0) throw new Error(`Included path(s) not found in the tree: ${missing.join(', ')}`);
  const root = buildTree(allFiles);
  const includedDirs = markIncluded(root, includedFiles);
  const globs = [];
  collectExcludes(root, '', includedDirs, included, globs);
  return globs.sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const allFiles = listTrackedFiles(args.repository, args.revision);
  const excludedPathGlobs = excludedPathGlobsFor(allFiles, args.include);
  const result = { revision: args.revision, includedPaths: args.include, excludedPathGlobs };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, serialized);
  else process.stdout.write(serialized);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`scope-policy failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
