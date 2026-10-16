# TriView-Compass

TriView-Compass is a model-agnostic static code review tool. It runs three independent LLM reviewers — code quality, security, and performance — against a deterministic, sanitized evidence snapshot of a change, validates every finding against the actual source before reporting it, and optionally verifies results in a rootless sandbox. It is report-only: no automatic patching, merging, or approval.

**Status: public, unannounced soft launch, pre-1.0.** The pipeline described below is implemented and covered by deterministic tests, a synthetic evaluation suite, and a 20-case corpus of real historical changes across seven ecosystems — see [RELEASE.md](RELEASE.md#empirical-accuracy-across-real-changes-phase-7) for the measured confirmed-finding, missed-defect, and wrong-anchor rates. TriView-Compass is an advisory second opinion, not a sole merge gate: expect occasional wrong-anchor citations, true-but-out-of-scope findings, and missed defects. Model truthfulness, unknown secret formats, provider-side data retention, and configured token assumptions remain stated limitations. See [RELEASE.md](RELEASE.md#public-launch-acceptance-phase-11) for the dated public-launch acceptance record and accepted residual risks.

**Choose your review harnesses.** A registered host asks whether to use the current harness or alternatives. Choosing none starts three isolated sessions on the current harness; multiple choices require role assignments. The bundled [TriView review skill](skills/triview-review/SKILL.md) supports explicit invocation and recognition of code-change review requests in compatible hosts. See [host integration](docs/host-integration.md) for installation and trusted host context. Standalone CLI use still supports explicit adapter modules and routes; no provider is guessed from installed binaries.

**Linux only.** Every deterministic check, sandbox verification, and live model review in this project's own evidence was run on Linux with rootless Podman. Git capture and the Podman sandbox runner are untested on macOS and Windows — Podman itself supports those platforms via a Linux VM, but that path has not been exercised here and is not a supported configuration.

New here? [Getting started in 5 minutes](docs/getting-started.md) is a straight path from a checkout to your first review report, with no architecture reading required first. Once that works, [the usage guide](docs/usage-guide.md) walks through the common real shapes of use — Git-based review, shared policies across repos, sandbox verification, audit retention, the setup wizard — each one a command actually run and recorded in the [end-to-end evidence](evals/evidence/e2e-manual-test-2026-10-15/README.md).

## Architecture at a glance

- **Code Quality Reviewer** — correctness, tests, architecture, maintainability, and readability.
- **Security Reviewer** — trust boundaries, vulnerabilities, privacy, secrets, and supply-chain risk.
- **Performance Reviewer** — complexity, data access, resource use, scalability, and measurement.
- **Four skills** — Core Review, Security Review, Performance Review, and Adversarial Input Review.
- **Deterministic core** — captures a fixed change snapshot, applies path/secret/size/token policies, dispatches through a trusted adapter, validates findings, and produces the report. Production session isolation depends on an adapter that enforces its declared controls.
- **Sandbox runner** — optionally executes verification in a constrained, rootless Podman environment. Missing or failed sandboxing must never fall back to host execution.

Every full review dispatches all three reviewers using the same sanitized immutable evidence bundle. The adapter must create separate contexts without shared memory or reviewer outputs. The core rejects reused context IDs and combines reports without silently discarding disagreements. Partial reviews require an explicit policy choice and are labeled accordingly.

Prompt format v2 provides numbered sanitized source and numeric Git change context. Reviews focus on defects introduced or worsened by the selected change; full mode means all three reviewer roles, not a whole-file audit of pre-existing issues. Redacted Git files withhold change coordinates because sanitization can shift lines; supplied-file modified/renamed inputs have no base comparison.

## Repository layout

```text
agents/                 Provider-neutral reviewer role prompts
skills/                 Four review-analysis skills, briefs, and host invocation skill
src/                    Core pipeline, CLI, adapters, and host integration API
adapters/                Harness/model/sandbox adapter contracts and examples
contracts/               Versioned input, policy, adapter, report, and audit schemas
                         and Phase 0 behavioral decisions
tests/                   Deterministic unit and integration tests
evals/                   Deterministic checks, model evaluations, evidence, and pilots
examples/                Example configuration and integrations
SECURITY.md              Threat model and current implementation status
CONTRIBUTING.md          How to propose a change, test expectations, maintainer bandwidth
CODE_OF_CONDUCT.md       Project conduct policy
CHANGELOG.md             Versioning policy (no release tagged yet)
docs/usage-guide.md      Real, run-verified examples beyond the 5-minute path
```

## Current commands

```bash
npm ci --ignore-scripts
npm test
npm run check:release
npm run check:package
```

The verification commands run structural and deterministic tests, release evidence checks, and a temporary package smoke check without model or network calls. Runtime validation uses the checked-in JSON Schemas through Ajv; provider capability claims still require trusted adapters. Run these checks inside the project Podman container as recorded in [verification notes](README.md#verification-and-manual-review).

New to this project's configuration? Run `node src/cli/setup.js` first — it asks a short series of yes/no questions (reviewers, data handling, one assistant or several, sandbox, audit) and writes a working `policy.json` for you, rather than requiring you to hand-write one against the schema. A terminal review without runtime flags also asks which harness to use; CI requires explicit flags and never prompts.

To run reviews automatically on pull requests, see [`examples/github-actions/`](examples/github-actions/README.md) for a copy-into-your-repo workflow template that posts the report as an advisory PR comment. It is honest about one real gap rather than hiding it: no model adapter this project ships today authenticates in a way that's turn-key on a stock GitHub-hosted runner, so two steps are left as documented `TODO`s for the adopter to fill in.

The CLI displays provider/control/token/sandbox preflight before calls, supports `--preflight-only true` without reviewer invocation, and offers JSON or readable `--format text` reports.

The harness-neutral CLI is documented in [src/cli/README.md](src/cli/README.md). Select a compatible adapter module, per-reviewer routes, or explicitly choose the Claude Code reference adapter with `--harness claude-code`. The shipped model adapters are Claude Code (hosted, qualified profile 2.1.300) and LM Studio (local, experimental). Additional harnesses need an implementation of the [adapter contract](adapters/README.md); naming a tool does not imply a shipped integration. Tests that call Claude Code run on the local host; deterministic tests remain in Podman.

## Verification and manual review

Latest deterministic checks: 151 tests passed in Podman, with structural, release-evidence, and 95-file package checks passing. Host selection tests use diagnostic adapters, not live providers. The historical expanded synthetic model suite passed 10/10 three-reviewer cases and 10/10 single-reviewer baselines, and the two-file real-source pilot completed with no findings after the evidence-context improvement. Those model results were not rerun for this host-integration change. Small samples do not establish general accuracy or superiority of three reviewers over one. See [evaluation evidence](evals/README.md), [pilot assessment](evals/pilots/git-capture/README.md), and [verification notes](README.md#verification-and-manual-review).

Semantic accuracy means that a finding is supported by the actual code, requirements, and change. Schema validation and valid line numbers cannot prove the claim. The original pilot demonstrated this: a suggestion about existing Git subprocess calls cited unrelated lines. Numbered source and change context improved the tested behavior; manual assessment remains necessary.

Before acting on a finding:

- Confirm that the cited lines show the claimed operation and that the failure is realistic.
- Compare base and target to establish whether the change introduced or worsened the issue.
- Assess severity and whether the recommendation preserves intended behavior and security controls.
- Reproduce blocking findings with focused tests where practical, running reviewed code inside Podman. Record the finding as confirmed, rejected, or unresolved.

Inspect important changed logic even when the report has no findings; defects can be missed. Passing expected-defect oracles is not a measurement of all false positives. Unexpected finding candidates still need interpretation.

## Where this fits in your review process

TriView-Compass does not replace the merge/approval gate. That gate is still a human — a code owner or maintainer with required-reviewer status enforced by branch protection, plus whatever deterministic CI checks (tests, lint, security scanners) and escalation policy (e.g., a security-team review for auth/crypto changes) the project already requires. Its reports are input to that human's decision, not a substitute approval; a finding only counts once a person has dispositioned it per [review checklist](README.md#verification-and-manual-review).

Building something that parses the report automatically (a CI comment formatter, a dashboard, a triage bot)? Read [the report contract](docs/report-contract.md) first — it's this project's one public, stable output format, with an explicit versioning policy and a test that pins the schema so a breaking change can't drift in unnoticed.

## Security and data handling

Read [SECURITY.md](SECURITY.md) for the threat model and the distinction between planned controls and controls already enforced. Read [architecture overview](README.md#architecture-at-a-glance) for the sandbox, model-provider, privacy, and failure policies.

The implementation is a private advisory preview. Model truthfulness, unknown secret formats, trusted host/provider behavior, and configured token assumptions remain limitations; reports do not automatically approve or merge changes. See [RELEASE.md](RELEASE.md) for scope and acceptance boundaries.

The initial input, budget, provider, path, secret, capability, sandbox, and failure decisions are recorded in [Phase 0 decisions](contracts/phase-0-decisions.md). The [default policy](examples/default-policy.json) contains no selected or allowlisted model provider, so model review requires explicit configuration. The [Claude subscription example](examples/claude-code-policy.json) shows an explicitly selected hosted provider; that provider receives sanitized source.

