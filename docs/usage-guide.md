# Usage guide: steps and examples

[Getting started](getting-started.md) covers the first run. [Choose your harness](harness-selection.md) before making model calls. The examples below explicitly choose the Claude Code reference adapter because the historical [2026-10-15 evidence](../evals/evidence/e2e-manual-test-2026-10-15/README.md) used it. They are not defaults. Current commands add `--harness claude-code` to record that choice; historical raw evidence remains unchanged. Substitute your own adapter or routes flags and matching policy for another harness.

## 1. Reviewing files directly, no Git repository

Use this when you want a quick check of a snippet, a generated file, or anything that isn't committed yet.

```json
{
  "contractVersion": "1.0",
  "input": {
    "kind": "files",
    "files": [
      { "path": "src/lib/run-backup.js", "changeType": "modified", "content": "...your code...\n" }
    ]
  }
}
```

```sh
node src/cli/review.js --request request.json --policy examples/claude-code-policy.json \
  --harness claude-code --model sonnet --context-window 300000 --format text
```

`--context-window 300000` and a policy with `maxInputTokensPerReviewer` raised to at least `200000` are not arbitrary — the default `100000` is frequently too small once Claude Code's own fixed 65,536-token protocol reserve is subtracted. See [`src/cli/README.md`](../src/cli/README.md#optional-sandbox-verification) and the Phase 9 [latency/cost evidence](../evals/evidence/latency-cost-2026-10-15/README.md) for why.

## 2. Reviewing a real commit range in a Git repository

This is the shape a CI job or a local pre-PR check actually uses. The field names are `baseRevision` and `targetRevision` — full 40-character commit SHAs, not branch names or short hashes:

```json
{
  "contractVersion": "1.0",
  "input": {
    "kind": "git",
    "baseRevision": "6ca0e48c6aebfd9d27b811cb0e4de149935d9514",
    "targetRevision": "75994f83a0202988c642d0533f88f9d2e36c67e9"
  }
}
```

```sh
node src/cli/review.js --request request.json --policy examples/claude-code-policy.json \
  --repository /absolute/path/to/your/repo --harness claude-code --model sonnet --context-window 300000 --format text
```

`--repository` must point at a working checkout that actually contains both commits. If you're building this request from a GitHub Actions `pull_request` event's base/head SHAs rather than typing it by hand, use [`examples/github-actions/build-review-request.js`](../examples/github-actions/build-review-request.js) — it validates both SHAs are full 40-character lowercase hex before writing anything, and fails loudly on a typo instead of producing a malformed request:

```sh
node examples/github-actions/build-review-request.js <baseSha> <headSha> > request.json
```

## 3. Sharing one policy across several repositories

Maintain one base policy centrally, and layer only what differs per repository with `--policy-overrides`:

```json
{ "contractVersion": "1.0", "reviewers": ["security"] }
```

```sh
node src/cli/review.js --request request.json --policy shared-base-policy.json \
  --policy-overrides repo-specific-overrides.json --harness claude-code --model sonnet --context-window 300000
```

Narrowing `reviewers` here also recomputes `mode` automatically (`full` → `partial`), so the two fields can't silently disagree. The merged policy is fully re-validated before use — a malformed or inconsistent override is rejected before anything runs, never silently coerced. See [`contracts/schemas/policy-overrides.schema.json`](../contracts/schemas/policy-overrides.schema.json) for every mergeable field (`budgets`, `pathPolicy.excludedPathGlobs`, `reviewers`, `sandbox`).

## 4. Verifying findings by actually running the code

Opt in per policy, then pass a pinned image and command:

```json
{
  "image": "registry.example/team/checks@sha256:<64 lowercase hex characters>",
  "command": ["your-command", "arg1", "arg2"]
}
```

```sh
node src/cli/review.js --request request.json --policy sandboxed-policy.json \
  --sandbox-config sandbox.json --harness claude-code --model sonnet --context-window 300000
```

(`sandboxed-policy.json`'s `sandbox` field must be `{"executionRequested": true, "backend": "podman", "network": "disabled"}` for this to take effect — see [`src/cli/README.md`](../src/cli/README.md#optional-sandbox-verification) for the exact resource limits and mount scope.) This requires a local rootless Podman installation and an image you already trust and have pulled; it never pulls one for you. `/src` inside the container holds only the included, sanitized, non-deleted captured files — not a full checkout — so pick a command that can actually run against that scope.

## 5. Keeping a record of past reviews without storing any code

```sh
node src/cli/review.js --request request.json --policy examples/claude-code-policy.json \
  --harness claude-code --model sonnet --context-window 300000 --audit-dir /absolute/path/to/audit --retention-days 30
```

Each run writes one metadata-only JSON record — hashes, counts, reviewer statuses, verdict — never raw source, findings text, or model output. `--retention-days 0` disables storage entirely; omit both flags for the same effect.

## 6. Letting the setup wizard write all of the above for you

Every example above requires a hand-written policy (and, for sandboxing or audits, a couple of extra files). If you'd rather answer a short series of questions instead:

```sh
node src/cli/setup.js
```

It writes `triview-setup/policy.json` (and `routes.json`/`sandbox.json`/`adapter-config.json` as needed) with owner-only permissions, and prints the exact `review.js` command — already filled in with every flag from the answers you gave — to run next. Re-running it is safe: it re-asks every question and overwrites its output rather than merging with a stale answer.

## Reading the result

Every example above can take `--format text` (human-readable) or omit it for JSON (automation-friendly; this is what the report schema actually guarantees — see [the report contract](report-contract.md)). Before acting on any finding, check `status` first: anything other than `"complete"` means part of the review didn't finish, and you should read `limitations` before trusting `findings` at all. See the main [README](../README.md#before-acting-on-a-finding)'s checklist for what to confirm before treating a finding as real.
