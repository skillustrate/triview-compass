# Contributing

Project metadata and documentation do not publish named contributor credits. Do not add author/contributor lists or co-author credit trailers. Keep the provider, model, adapter, and tool identities needed for accurate runtime reporting and evaluation evidence.

This project is report-only, deterministic-core, provider-neutral by design — see [README.md](README.md)'s architecture section before proposing a change that touches `src/core/`; a lot of behavior here is intentional, not an oversight. If you're unsure whether something is a bug or a deliberate boundary, open an issue and ask before writing code.

## Maintainer bandwidth — read this before opening something and expecting a fast reply

This is currently a single-maintainer project with no dedicated team, no triage staff, and no contractual response SLA for anything other than a security report (see [SECURITY.md](SECURITY.md)'s own, separate timeline). In practice that means:

- Issues and PRs are reviewed best-effort, not on a fixed schedule. There is no promised time-to-first-response.
- The maintainer is the only person who can merge. There is no delegated reviewer or bot-based auto-merge.
- An issue that goes quiet (no maintainer response, and no reproduction or follow-up from the reporter) for **90 days** may be closed as stale rather than left open indefinitely. Closing isn't a verdict that the issue was wrong — reopen it with new information and it'll be looked at again.
- A PR that sits without a response for a similarly long stretch isn't a rejection either; ping the issue/PR itself (not a side channel) if it's been quiet longer than that and still matters to you.

This section exists so unmanaged expectations don't become the reason this project looks abandoned — that's a far more common way a public OSS project visibly fails than any actual code-quality problem, and it's cheaper to state plainly now than to let people guess.

## Proposing a change

1. **Open an issue first for anything non-trivial** (new adapter, new CLI flag, a change to `src/core/`'s contracts or policy schemas). A PR that reshapes a contract without prior discussion is more likely to need rework.
2. **Small, focused fixes** (a typo, a clear bug with a small diff, a missing test) can go straight to a PR.
3. Keep the architecture provider-neutral: core logic in `src/core/` stays model/harness-agnostic; anything specific to one model/harness/sandbox belongs behind the adapter boundary in `adapters/`/`src/adapters/`, never hard-coded into `src/core/` or the CLI's own flag parsing. This is a hard rule here, not a preference — see [README.md](README.md)'s architecture section for why.

## Coding and test expectations

- Deterministic tests, release checks, and the package smoke check must pass before a PR is reviewed:
  ```sh
  npm ci --ignore-scripts
  npm test
  npm run check:release
  npm run check:package
  ```
  Run these inside the project's Podman container — host-level Node version drift has caused real false passes/failures here before.
- `.github/workflows/ci.yml` runs the same checks plus a dependency audit on every PR, including from forks, with no secrets required.
- New behavior needs a new deterministic test demonstrating it, not just a description in the PR body. If you found a bug via a live run against a real adapter (the most reliable way bugs have actually been found in this project so far), include a regression test that would have caught it with a mocked adapter too, where that's possible.
- Don't add a new secret-scanning pattern, a new budget default, or a new policy field without updating the matching contract schema in `contracts/schemas/` and `docs/report-contract.md`/`SECURITY.md` if it's public-contract-relevant — see `tests/report-contract-stability.test.js` for what's pinned and why.

## Requalifying a new Claude Code CLI version

See [`docs/requalification-runbook.md`](docs/requalification-runbook.md) for the exact steps and who needs to approve them. Every prior CLI version bump in this project's history followed this same shape; the runbook exists so a second person can do it without reconstructing the process from git history.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report a violation the same way you'd report a security issue privately — see SECURITY.md's channel — since there is no separate conduct-reporting infrastructure yet for a single-maintainer project at this stage.
