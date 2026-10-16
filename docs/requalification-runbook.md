# Requalifying a new Claude Code CLI version

`src/adapters/model/claude-code.js` pins `SUPPORTED_CLI_VERSION` and refuses (`CAPABILITY_UNAVAILABLE`) before any source preparation if the installed `claude` CLI reports a different version. This is deliberate: silently proceeding against an unverified CLI version would make every claim this project makes about enforced controls (safe mode, restricted mode, fresh context per reviewer) an assumption again, not a checked fact. This runbook is what to actually do when that refusal fires and the new version needs to be qualified, not bypassed.

This procedure has been run for real twice so far (2.1.296 → 2.1.299, then 2.1.299 → 2.1.300). It is written down here so a second person can do it without reconstructing the process from git log.

## Who approves this

On a single-maintainer project, the maintainer approves every requalification — there is no separate approver role yet. If this project grows a second maintainer, update this line to say who that is and whether review is required before merging a requalification, rather than leaving this section stale.

## Steps

1. **Confirm the refusal is really a version mismatch**, not something else. Run `claude --version` and compare it to `SUPPORTED_CLI_VERSION` in `src/adapters/model/claude-code.js`. The preflight report's `code` will be `CAPABILITY_UNAVAILABLE`.
2. **Bump the pin.** Update `SUPPORTED_CLI_VERSION` to the new version string.
3. **Update every current-tense reference to the old version**, not just the pin:
   - `tests/claude-code.test.js` (the literal version string the tests assert against)
   - `src/adapters/model/README.md`
   - `src/cli/README.md`
   - `docs/capability-matrix.md`
   - `docs/security-review.md`
   - `RELEASE.md`
   - `README.md`

   **Leave historical, dated narrative alone.** Past records (e.g. a corpus case's `runs[].label` reading "live run, Claude Code CLI 2.1.299, ...") describe what actually happened at the time, not current documentation — do not rewrite history to make it look like the old runs used the new version. Add a new entry describing the requalification instead of editing the old one.
4. **Run the deterministic suite with no model calls**: `npm test` inside the project's Podman container. This should pass unchanged — the version bump by itself doesn't change any deterministic logic.
5. **Re-run the live synthetic suite against the new version** to requalify it, not just the pin:
   ```sh
   node evals/scripts/run-model-evals.js --harness claude-code --model sonnet --context-window 200000 \
     --output evals/evidence/evidence-context-sonnet-<date>-cli<version>.json
   ```
   Never overwrite an existing evidence file — each requalification gets its own, dated and versioned, so a regression is visible in the history rather than silently replacing the last known-good evidence.
6. **Compare the new result to the last qualified baseline.** A drop (fewer passing cases, a new `semanticAnchorViolations` flag, a newly-unmatched expected finding) is a real signal, not noise to average away — the 2.1.299 requalification found a real 10/10 → 8/10 regression against a tightened oracle this way, and it was reported as such rather than treating the new baseline as automatically correct.
7. **Repoint `check-release.js` at the fresh evidence file** and run `npm run check:release && npm run check:package` to confirm both still pass.
8. **If a corpus case run (Phase 7) was in progress when the refusal fired**, requalify before continuing that case, not around it — don't special-case a single corpus run to use the old pinned version just to finish it.
9. **Record the requalification** (in your PR description or your own project's internal log): what triggered it, the old and new versions, which files were updated, the before/after synthetic-suite scores, and the exact evidence file path. This is what makes the next requalification (by you or someone else) faster than this one was.

## What this runbook does not cover

Requalifying a different adapter (LM Studio, or a user-supplied `--adapter-module`) has no equivalent pinned-version gate today — those adapters don't hard-pin a version the way the Claude Code adapter does. If one needs a similar gate in the future, model it on this same shape (refuse before source preparation on a mismatch, never silently proceed) rather than inventing a new pattern.
