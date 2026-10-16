# GitHub Actions template

A drop-in workflow that runs TriView-Compass against every pull request and posts the report as an advisory comment. It is report-only by design: see [README.md's "Where this fits in your review process"](../../README.md#where-this-fits-in-your-review-process). **Never add this job as a required status check** — a failed, incomplete, or timed-out review must never block a merge, which is why the template sets `continue-on-error` throughout.

## What's in this directory

- [`triview-review.yml`](triview-review.yml) — the workflow itself. Copy it into your repository's `.github/workflows/`.
- [`build-review-request.js`](build-review-request.js) — a small script that turns a pull request's base/head commit SHAs into the request JSON `review.js --request` needs. Covered by [`tests/build-review-request.test.js`](../../tests/build-review-request.test.js).
- [`policy.json`](policy.json) — a starting policy (full review, Claude Code hosted). Copy it to `.triview/policy.json` in your repository and adjust it (budgets, path exclusions, reviewer subset) for your project.

## What you still have to fill in, and why

This template deliberately ships with two gaps marked `TODO (adopter)`, rather than a false claim that everything works out of the box:

1. **Installing TriView-Compass itself.** No published registry package exists yet (tracked in plan.md's Phase 10 — the open-source governance and release phase). Until then, install from a pinned commit of wherever you sourced this project from.
2. **A model adapter that actually works on your runner.** This project ships two real model adapters today, and neither is a good fit for a stock `ubuntu-latest` GitHub-hosted runner, for different reasons:
   - **Claude Code** (`src/adapters/model/claude-code.js`) is a hosted subscription CLI that authenticates interactively (`claude auth login`) into a `CLAUDE_CONFIG_DIR` profile directory. It has no API-key env-var path — the adapter explicitly strips `ANTHROPIC_*`/`CLAUDE_*` env vars before every invocation, so you cannot just set a secret and go. The real option, documented here but **not verified by this project in an actual CI run**: authenticate a profile once on a machine you control, archive that `CLAUDE_CONFIG_DIR` directory, store it as a base64 GitHub Actions secret, and have a workflow step decode it to `$RUNNER_TEMP/claude-config` before calling `review.js` with `--adapter-module src/adapters/model/claude-code.js` style wiring (or the built-in `--harness claude-code --model`/`--context-window` path, pointing `CLAUDE_CONFIG_DIR` at the restored directory via the adapter's `configDir` option). Treat this as a starting point to test yourself, not a guarantee.
   - **LM Studio** (`src/adapters/model/lm-studio.js`) needs a local LM Studio server with a model loaded, reachable over the network. That doesn't exist on a GitHub-hosted runner at all. It's a realistic option only on a **self-hosted runner** that already has (or can reach) a running LM Studio rig — point `--adapter-config` at that rig's real `baseUrl`/`modelId`, supplied through a secret, never committed.
   - **Anything else** (Codex, Antigravity, a direct hosted-API adapter you write yourself against `examples/adapter-template.js`) works the same generic way: write the adapter, keep its connection details in a secret-sourced `--adapter-config` file, and point `--adapter-module`/`--adapter-export` at it in the workflow.

   This gap is itself worth naming plainly: **no adapter this project ships today is turn-key for a GitHub-hosted runner.** A direct hosted-API model adapter (e.g., calling a provider's own HTTPS API with a secret-sourced key, no local CLI or server involved) would be — that's recorded as an open backlog item in plan.md's Phase 9 progress notes, not something this template can paper over by pretending Claude Code or LM Studio already solve it.

## Setting up your policy and routes

Don't hand-write `.triview/policy.json` against the schema — run `node src/cli/setup.js` locally once (see the main README) to generate a working one interactively, then commit the result. If you need different accounts/adapters per reviewer role, the wizard also writes a matching `routes.json`; reference it from the workflow with `--routes .triview/routes.json` instead of the `--adapter-module`/`--adapter-export` flags shown in the template.

If several repositories should share one base policy (e.g. an org-wide standard) but each needs a small per-repo tweak -- a different budget, an extra excluded path, a narrower reviewer subset -- commit a small `.triview/overrides.json` instead of a second full policy, and add `--policy-overrides .triview/overrides.json` to the `review.js` call in the workflow. See [`src/cli/README.md`](../../src/cli/README.md) and [`examples/policy-overrides.json`](../policy-overrides.json) for the exact shape.

## The posted comment

The workflow posts `review.js --format text`'s output (or its stderr, if the run refused before producing a report) as one issue comment per run, truncated to stay under GitHub's comment size limit. It never edits or deletes a previous comment, so a pull request accumulates one comment per push — tell your workflow to use `actions/github-script`'s update-in-place pattern instead if that's noisier than you want; this template favors a correct, simple baseline over a polished one. The comment's code fence is sized longer than the longest backtick run actually present in the (untrusted — it's derived from the reviewed PR's own diff) output, so a crafted finding title or diff line can't break out of it and render as live markdown.

## A disclosed risk this template does not fully solve: the policy comes from the PR's own checkout

`fetch-depth: 0` plus `actions/checkout`'s default behavior means `.triview/policy.json` is read from the pull request's **head** — the PR author's own branch — not from your repository's trusted default branch. A malicious PR author can therefore edit `.triview/policy.json` in their own PR to change the review's budgets, path exclusions, secret-scanning settings, or data-handling mode for that PR's own run, before the workflow ever reads it.

Found by a live review of this exact template, not invented after the fact; not fixed in the template itself because doing so properly means deciding *where* the trusted policy comes from (a second checkout of the base ref's `.triview/policy.json`, specifically), which is a real design decision for your repository, not a one-line patch this template can make for you. If this matters for your threat model (e.g., the policy controls whether sanitized source reaches a hosted provider at all), check out the policy file from `github.event.pull_request.base.sha` with a second, narrowly-scoped `actions/checkout` step instead of reading it from the already-checked-out head, and pass that path to `--policy` instead.
