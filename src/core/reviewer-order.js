// The one canonical reviewer order, matching common.schema.json's "reviewer"
// enum. Shared so a reviewer subset always comes out in the same order
// wherever one is built (the setup wizard, policy overrides, etc.), rather
// than each caller inventing its own.
const CANONICAL_ORDER = ['code-quality', 'security', 'performance'];

export function orderReviewers(reviewers) {
  return CANONICAL_ORDER.filter((role) => reviewers.includes(role));
}

export function reviewModeFor(reviewers) {
  return reviewers.length === 3 ? 'full' : 'partial';
}
