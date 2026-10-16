# Synthetic live-review attempt — 2026-10-16

This is a real CLI/provider invocation attempt, not a successful model-quality evaluation. The operator selected the qualified Claude Code 2.1.300 binary and `sonnet` for this historical run; that selection does not define the tool's default harness.

The three newly added synthetic files contain deliberate percentage arithmetic, shell-injection, and quadratic-scan defects. Preflight was ready, all three reviewer invocations failed, the report was `incomplete`, and the CLI exited 2 after 11.36 seconds. Zero findings means no successful assessment, not a clean change.

A separate source-free request also failed with JSON `is_error: true`; an allowlist classifier matched the term `oauth`. Only diagnostic categories were retained. The exact OAuth failure was not saved, and this does not independently establish the cause of each original reviewer failure. Credentials and raw provider error text are absent.

Artifacts:

- `request.json` / `policy.json`: synthetic source and the explicitly chosen policy.
- `report.json` / `report.txt`: actual consolidated output and its readable rendering.
- `preflight-and-timing.txt`: captured preflight and process timing.
- `provider-diagnostic.json`: source-free diagnostic summary.
- `create-sample.mjs`: regenerates the request and a temporary adapter configuration using the qualified binary under the current user's home directory. It neither installs a harness nor changes authentication.

To reproduce from the installed project root, first confirm that this is the harness the user wants, that the qualified binary exists, and that authentication works:

```sh
node evals/evidence/codex-live-review-2026-10-16/create-sample.mjs
node src/cli/review.js \
  --request evals/evidence/codex-live-review-2026-10-16/request.json \
  --policy evals/evidence/codex-live-review-2026-10-16/policy.json \
  --adapter-module src/adapters/model/claude-code.js \
  --adapter-export createClaudeCodeModelAdapter \
  --adapter-config /tmp/triview-codex-live-adapter.json
```

The later current-harness integration passed 151 deterministic tests using diagnostic adapters. Those tests do not repair or replace this failed live-provider run.
