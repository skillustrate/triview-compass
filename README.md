# TriView-Compass

TriView-Compass reviews code changes using three independent reviewers: code quality, security, and performance. It captures a fixed change snapshot, filters sensitive content, validates findings against source evidence, and produces an advisory report. Optional verification runs in a rootless Podman sandbox.

## Get started

Follow [Getting started](docs/getting-started.md) for installation and your first review, then the [usage guide](docs/usage-guide.md) for Git changes, shared policies, sandbox verification, and audit retention.

A compatible host can invoke the bundled [review skill](skills/triview-review/SKILL.md) explicitly or recognize a user request to review a code change. The current harness asks which review harnesses to use. Choosing none uses three isolated sessions of the current harness; choosing alternatives uses the selected harnesses with explicit reviewer assignments. See [harness selection](docs/harness-selection.md) and [host integration](docs/host-integration.md).

Standalone CLI use requires an explicit adapter or harness selection. The shipped adapters are Claude Code (qualified reference profile) and LM Studio (experimental); other harnesses require a compatible adapter. Naming a harness does not install or implement it. Provider allowlists, data handling, budgets, and isolation controls still apply.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `src/` | Core pipeline, CLI, adapters, and host integration |
| `agents/`, `skills/` | Reviewer prompts, analysis skills, and invocation skill |
| `contracts/`, `adapters/` | Schemas, behavioral contracts, and adapter guidance |
| `examples/`, `docs/` | Configuration, integrations, and usage documentation |
| `tests/`, `evals/` | Automated checks, reproducible evaluation fixtures, and required release evidence |

Private planning documents, local reports, generated output, optional community templates, and superseded run artifacts are ignored. They are unnecessary for using the tool. The repository retains fixtures and evidence required by its automated checks.

## Validate

Use Node.js 20 or newer. The tested environment is Linux with Node.js 24.18.1 and rootless Podman.

```sh
npm ci --ignore-scripts
npm test
npm run check:release
npm run check:package
```

These checks make no model calls. See [evaluation guidance](evals/README.md) for optional model evaluations and [release notes](RELEASE.md) for qualification evidence and limitations.

## Boundaries

Reports support human review; they do not automatically patch, merge, or approve changes. Each full review uses three isolated contexts against the same sanitized evidence. Unknown secret formats, incorrect model findings, and missed defects remain possible. Hosted providers receive sanitized source only under an explicitly configured policy. Sandbox verification covers included sanitized files rather than a full dependency-equipped checkout.

Linux is the tested platform; macOS and Windows are unqualified. See [SECURITY.md](SECURITY.md), the [capability matrix](docs/capability-matrix.md), and the [report contract](docs/report-contract.md).
