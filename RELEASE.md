# V1 public, unannounced soft launch

The implemented product performs bounded, report-only review with three independent reviewers, explicit provider policy, source/path filtering, validated findings, optional rootless verification, and metadata-only retention. It is report-only, not an autonomous approval/merge gate. No package publication (npm) is part of this release; distribution is clone/install from the GitHub repository itself.

The reference subscription profile is Claude Code 2.1.300. Other CLI versions refuse before source preparation until requalified. One subscription can run all three reviewers; optional account/model routes remain explicit. LM Studio is a programmatic experimental adapter; Antigravity has no supported adapter. See the [capability matrix](docs/capability-matrix.md) and [security review](docs/security-review.md) for guarantees, assumptions, data flow, and update procedure. The consolidated report's output format is a versioned public contract; see [the report contract](docs/report-contract.md) for its field reference and versioning policy before building anything that parses it.

## Reproduce checks from the trusted source checkout

```sh
npm ci --ignore-scripts
npm test
npm run check:release
npm run check:package
npm audit --omit=dev
npm pack --dry-run --json
```

Deterministic tests and release checks run inside the project Podman environment. Model evaluations run on the local host through the subscription:

```sh
npm run eval:models -- --harness claude-code --model sonnet --context-window 200000 --output /private/existing-directory/new-results.json
```

This runs ten synthetic cases with three reviewers and a single-code-quality baseline. It sends synthetic input only, never executes fixtures, requires a new output file, and saves scores/latency/numeric usage plus suite/guidance/lock hashes. `--case ID` selects a focused case. `--inspect true` explicitly displays sanitized finding summaries for diagnosis; those summaries are not saved in the metrics artifact. Provider-reported dollar values are API-equivalent estimates, not subscription charges. Keyword oracles and unexpected-finding counts are advisory; release safety rests on deterministic controls and explicit limitations.

Current numbered-source/change-context evidence is in [the model evaluation](evals/evidence/evidence-context-sonnet-2026-10-14.json). The [Phase 6 evaluation](evals/evidence/phase6-final-sonnet-2026-10-14.json) preserves the earlier eight-case qualification. Earlier artifacts preserve the clean false alert and safely refused invalid anchors rather than hiding them. In the Phase 6 run, all eight full-review cases and all eight baselines passed their oracles. The expanded suite additionally tests exact evidence at line 43 and suppression of unchanged pre-existing issues. Full review used more tokens and API-equivalent cost and was slower; this suite does not establish that three reviewers outperform one. Follow-up trials and representative real changes are needed for broader quality claims.

Evidence is available in the source checkout and excluded from the portable runtime package along with local handoff files. The package smoke check uses the existing audited dependencies, verifies the extracted CLI and all schema/role/skill assets, and removes its temporary archive. It does not test registry installation or publish the package. Checks were run in Node 24.18.1/npm 11.12.1 inside `dev-box`.

The final run observed `claude-sonnet-5-5`; `sonnet` remains a configured alias. Context capacity and wrapper reserve are assumptions exposed in preflight. The tiny clean case and anchored defect fixtures do not represent production repositories. Secret scanning is best effort: Basic-auth payloads and common query-string secret parameters are now detected (9/9 values across the contextual corpus's positive cases, 0 false alerts across its negative cases — see `evals/fixtures/secret-scanning/corpus.json`), but a secret with no recognized format at all remains an undetectable, documented gap. An explicitly approved hosted model receives sanitized source even when execution is sandboxed. Sandbox verification contains only included sanitized non-deleted files, not dependencies or a full checkout.

Release acceptance for this scope requires passing deterministic checks, mapped threat coverage, reviewed adapter/update boundaries, current dependency audit, no automatic mutation/unsandboxed execution, and completed behavior evidence with disclosed limitations. The npm package is kept private (`"private": true` in `package.json`) by deliberate distribution choice, not an unmade decision — see the public-launch acceptance record below for the GitHub-publication decision itself.

Prompts now use explicit one-based source numbers and numeric Git hunk coordinates. Evidence line numbers refer to sanitized target content (base content for deleted files), not the numbering prefixes. Redacted Git files withhold hunk coordinates; supplied-file modified/renamed requests have no base comparison. The real-change pilot found a structurally valid but semantically wrong anchor; this remains a model-quality risk requiring manual assessment.

The final expanded run passed 10/10 three-reviewer cases and 10/10 baselines, with zero violations of the narrow semantic-anchor oracle. It still recorded 18 full-review and 5 baseline unexpected-finding candidates (including duplicate specialist findings); these are not independently verified false positives. Mean latencies were 10,770 ms and 6,475 ms; reported API-equivalent totals were USD 0.4612611 and 0.1536767. The unchanged two-file real-source pilot also completed with no findings. Initial scope failures remain in the curated evidence.

## Empirical accuracy across real changes (Phase 7)

A 20-case corpus spans seven ecosystems (JS/npm, Python/PyPI, Go, Rust, Java, C#/.NET, C) and three ground-truth types: 13 `known-fix` (a real historical fix commit), 4 `known-defect-present` (a confirmed, still-present defect), 3 `known-clean` (nothing to find). 16 cases are sourced from external public repositories; the rest from this project's own history. Full manifests, ground truth, and per-finding dispositions are in [evals/corpus/](evals/corpus/README.md).

As of the 20-case corpus (generated 2026-10-15):

- **Confirmed-true-positive rate among blocking (Required/Critical) findings: 7/8 (87.5%).** The one non-confirmed blocking finding (case 008) was factually accurate and reproduced exactly as claimed, but reproduced identically against the base revision too — rejected on scope grounds, not accuracy grounds.
- **Recall on known-defect-present cases: 4/4 (100%)** — every case with a confirmed, still-present defect had that defect found and confirmed by at least one reviewer. This is a 4-case sample; a 100% figure at this size does not generalize.
- **False positives on known-clean cases: 0/3** — all three deliberately "nothing to find" cases (a docs-only commit, a changelog-only commit, a five-file comment-typo diff) returned zero findings from all three reviewers.
- **Wrong-anchor rate among rejected findings: 1/2 (50%)** — of the 2 findings rejected on any grounds, 1 cited an incorrect line/location.
- **A recorded miss outside the tracked metric:** case 017 (a `known-fix` case, not `known-defect-present`) returned zero findings from all three reviewers, but a real residual gap in the reviewed fix was found on independent investigation and was not raised by any reviewer. It is not counted in `knownDefectMissedCount` because that metric only tracks the 4 cases explicitly labeled `known-defect-present`; it is disclosed here because a clean run is not proof of a correct run.

**These numbers describe only this 20-case corpus.** They are not independently verified against a held-out set, not statistically powered for a general accuracy claim, and skew toward security-category findings (every confirmed blocking finding so far is security or a security/correctness crossover — no code-quality-only or performance-only confirmed finding exists yet). See `evals/corpus/metrics-log.jsonl` for the full trend and `evals/corpus/README.md` for what would need to change before a larger claim is defensible.

**TriView-Compass is an advisory second opinion, not a sole merge or approval gate.** Based on the corpus above: most blocking findings were accurate and in scope (7/8 confirmed), no known defect went undetected among the cases built around a confirmed defect (4/4), and no known-clean change produced a false alarm (0/3) — but the corpus also recorded one wrong-anchor citation, one true-but-out-of-scope finding, and one case where a real residual gap went unflagged by all three reviewers. Expect occasional incorrect citations, true findings that are out of this change's scope, and missed defects; expect no finding to be acted on without the manual disposition process in [README.md](README.md)'s "Before acting on a finding" checklist. Treat every report as input to a human decision, never as the decision itself.

## Public-launch acceptance (Phase 11)

**Decision: go, as a soft/unlisted launch.** Dated 2026-10-16. This repository is public as of this date. No announcement has been made and none is planned yet; this is a deliberate quiet period to let a few trusted early users exercise the project before wider visibility, not an oversight. This supersedes the "private advisory preview" label used earlier in this project's history.

**Evidence this decision rests on:**

- Deterministic core, three isolated reviewers, validated findings, optional sandboxed verification, and metadata-only audit retention are implemented and covered by 139 passing deterministic tests, a 10/10 synthetic three-reviewer suite, and the 20-case real-change corpus above.
- Security hardening closed real gaps found via independent review and dogfooding: secret-scanner coverage expanded (Basic-auth, query-string secrets), an independent sandbox image scan published, a real second-harness isolation probe run, and — in the lead-up to this decision specifically — a live end-to-end manual test pass ([`evals/evidence/e2e-manual-test-2026-10-15/`](evals/evidence/e2e-manual-test-2026-10-15/README.md)) that caught and fixed a shell-injection/error-handling/complexity bug in example code, plus a genuinely independent, non-Claude second opinion (OpenAI Codex CLI) on that evidence commit, which found nothing further.
- Open-source governance is in place: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, issue/PR templates, and a security-reporting channel that is live (GitHub's private advisory feature).
- Distribution is deliberately GitHub-only clone/install, not npm registry publication — `package.json` keeps `"private": true` by choice.

**Residual risks accepted as of this decision, not fixed before launch:**

- Model truthfulness is unverified; the 20-case corpus is not statistically powered for a general accuracy claim and skews toward security-category findings (see above).
- A secret with no recognized format at all remains an undetectable, documented gap in the scanner.
- Linux only — macOS/Windows (via Podman's Linux VM) are untested and unsupported.
- The GitHub Actions template has two disclosed, adopter-filled gaps: no bundled install source, and no CI-turn-key model adapter.
- Sandbox verification covers only included, sanitized, non-deleted captured files — never a full checkout or dependency tree.
- LM Studio remains an experimental adapter; Antigravity has no supported adapter.

**Retirement condition for the "soft launch" qualifier:** this label is retired (replaced with a dated note here) when the maintainer makes any public announcement of the project — a decision deliberately left open-ended rather than tied to a specific date or metric, since the whole point of the quiet period is to let that decision be made deliberately when it's actually warranted, not on a schedule set in advance.
