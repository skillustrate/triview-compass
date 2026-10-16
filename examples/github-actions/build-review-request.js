#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Builds a v1 review request (Git input) from two full commit SHAs -- e.g. a
// GitHub Actions `pull_request` event's base/head SHAs. Kept as a tiny
// separate script rather than inline shell JSON in the workflow YAML so it's
// testable and so a typo in a SHA fails loudly instead of producing a
// malformed request.
//
// Usage: node build-review-request.js <baseSha> <headSha>
// Prints the request JSON to stdout; writes nothing to disk itself.

const COMMIT_ID = /^[a-f0-9]{40}$/u;

export function buildReviewRequest(baseRevision, targetRevision) {
  if (!COMMIT_ID.test(baseRevision ?? '') || !COMMIT_ID.test(targetRevision ?? '')) {
    throw new Error('Both revisions must be full 40-character lowercase hex commit SHAs.');
  }
  return { contractVersion: '1.0', input: { kind: 'git', baseRevision, targetRevision } };
}

// Template-literal file:// URLs don't percent-encode spaces, '#', or other
// special characters, and don't normalize Windows drive-letter paths, so
// they can silently fail to match import.meta.url on some paths/platforms.
// pathToFileURL handles both correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baseSha, headSha] = process.argv.slice(2);
  try {
    process.stdout.write(`${JSON.stringify(buildReviewRequest(baseSha, headSha))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nUsage: node build-review-request.js <base sha> <head sha>\n`);
    process.exitCode = 1;
  }
}
