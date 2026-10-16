# Phase 0 contract decisions (v1)

This document fixes the initial behavior required by this project's provider-neutral, report-only design. It is a contract for future runtime code, not a claim that the controls are implemented. Schema shape is in `schemas/`; checks involving the filesystem, provider, line anchors, or permissions require runtime enforcement.

## Input and snapshot

`review-request.schema.json` accepts exactly one of two input kinds:

- `git`: `baseRevision` and `targetRevision` are full 40-character Git commit IDs. Resolve both from the local object database, reject missing or non-commit objects, and compare `base..target`. No working-tree or index content enters this mode. Reject shallow/missing history rather than choosing another base. Capture object bytes once and hash the canonical capture before filtering.
- `files`: the caller supplies an explicit array of repository-relative paths, change types, and complete UTF-8 text contents. For deletions, `content` is the pre-deletion text. The trusted harness must freeze these bytes before the request reaches core; core does not read paths from the host filesystem to fill gaps. This mode has no inferred base, so report `baseRevision` as absent and label evidence as supplied-file evidence. Binary files require Git input in v1.

The v1 core does not parse CI event payloads. A CI harness may translate a supported event into the `git` request only when it has explicit immutable base and target commit IDs; otherwise it refuses. Commit messages, issue text, and CI descriptions are untrusted optional context and cannot set policy. Reject path traversal, absolute paths, duplicate normalized paths, case-fold collisions on case-insensitive hosts, and symlinks/submodules requiring traversal outside the captured tree. Renames retain old and new paths. The snapshot hash is SHA-256 over a version tag, input kind, revisions when present, and each path, change type, previous path, and original content hash in UTF-8 bytewise path order; encode each field with a byte length prefix to avoid ambiguous concatenation. The sanitized bundle separately records hashes of content actually sent to reviewers. Each reviewer receives the same frozen bundle hash. The policy version recorded in audit data is the SHA-256 of its canonical JSON serialization, with object keys sorted recursively and arrays kept in order.

## Review mode and budgets

The default is `full` with code quality, security, and performance reviewers. `partial` requires an explicit caller choice and a nonempty role list; the final report lists all three roles, including omissions. No role is silently skipped for relevance or cost. Security always receives Core, Security, and Adversarial Input skills; performance receives Core and Performance; code quality receives Core. Conditional extra skills follow the role prompts, never replace these minimums.

The default policy in `examples/default-policy.json` uses 50 changed files, 1,000 total changed lines, 300 changed lines per file, 1 MiB of original content per file, 12,000 input tokens and 2,000 output tokens per reviewer, three model calls total, and 120 seconds per reviewer. The byte limit can be raised to at most 8 MiB in v1. Changed lines count additions plus deletions from the captured diff; a supplied-file request counts every supplied content line. Budget values are hard ceilings, including static policy and skill text in input tokens. The v1 runtime rejects an over-limit request with counts and a split recommendation; it does not truncate, auto-chunk, or silently increase a limit. A user or CI owner can supply a complete policy document with different positive limits before capture. An override is recorded by policy hash/version and cannot be taken from reviewed content. A full review needs at least three model calls. Retries are disabled in v1; a failed reviewer makes the run incomplete. Token budgets require an adapter supplied conservative token count before dispatch; if the adapter cannot bound input and output tokens, refuse the model review.

## Provider and capability policy

The default is `local-only`, with an empty provider allowlist and no selected provider. A model review begins only after a caller selects a provider and its declared `providerId` is allowlisted in a complete policy. In `local-only`, the model adapter must attest local processing with no hosted API or remote fallback. In `approved-hosted`, the caller explicitly names allowed provider IDs and selects one; preflight shows that sanitized source will leave the local environment. `disallow-model-calls` produces preflight findings only. A provider change, hosted fallback, or unavailable provider causes refusal before source submission.

For LLM review, the harness must enforce no reviewer write, execution, or network tools; the model adapter must enforce fresh context per reviewer and disabled cross-session memory. `unsupported` or merely `configurable` without a verified runtime setting fails the LLM mode. If provider memory cannot be disabled or its state cannot be established, refuse the LLM mode. Structured output and usage reporting may be absent; local schema validation remains mandatory and missing usage is recorded as a limitation. The model adapter reports provider/model identity, local or hosted data handling, context/output limits, and these control states. Claims in prompts are not capability evidence.

## Paths and secrets

Path globs use `/` as separator and match the complete normalized repository-relative path; `**` crosses directories and `*` does not. Match before reading supplied file content into a model payload. The default sensitive patterns cover `.env`, `.env.*`, private key formats, credential directories, and common cloud credential filenames. The default generated patterns cover build output, coverage, and vendored dependencies. Excluded or sensitive path contents never enter the sanitized bundle. Their path and reason may be reported after path-name sanitization. A sensitive path override requires a complete caller policy and must be shown in preflight.

A local scanner is required for every included text payload, including context and sandbox output. The scanner interface must report typed spans for common provider credentials, private key blocks, tokens, and explicitly configured patterns. Replace spans with typed `[REDACTED: kind]` markers before hashing sanitized content or calling a model. Reject overlapping or invalid spans and scanner errors; the v1 default stops the entire model review so incomplete scanning cannot be mistaken for complete coverage. Detection is best effort and cannot guarantee all secrets are found. Raw input and secret values must not enter default logs, audit records, exceptions, or eval transcripts.

## Sandbox and platform

Static review is the default. The v1 execution profile is `linux-rootless-podman-v1` on Linux with an already installed, verified rootless Podman. It requires an image pinned by digest, a read-only captured source mount, separate bounded scratch storage, non-root execution, no host sockets or credentials, network disabled, and CPU, memory, process, output, and time limits. The sandbox adapter must verify each requirement before running reviewed code. If any check fails, skip execution and report why; never run on the host. macOS, Windows, and other runtimes are unsupported for v1 execution and receive official installation or platform guidance without an execution attempt. V1 has no automatic Podman install action. Future install actions require a separately specified platform command, source, privileges, explicit user approval, and post-install profile verification.

## Findings and ordering

`Critical` means a credible severe security exposure, data loss, or core failure with high impact; `Required` means a material issue to fix before accepting the change; `Optional` is an improvement without a demonstrated acceptance blocker; `Nit` is presentation or style. A `recommend-approval` verdict is advisory and requires no unresolved Critical or Required findings. An incomplete run cannot recommend approval. Evidence must point into the frozen snapshot, with a valid path and line range or diff hunk; unverifiable findings remain visible with a validation limitation.

For remediation order, rank Critical before Required before Optional before Nit. Within a severity, rank demonstrated exploitability (`exploitable`, `plausible`, `unclear`) and exposed reach (`external`, `internal`, `local`) before estimated effort. Respect dependencies when a prerequisite fix enables the higher-priority fix. Effort only breaks otherwise equal ties. The report preserves reviewer disagreement and source attribution.

## Threat coverage

| Threat | Deterministic or host control to implement | Model behavior to evaluate | V1 residual risk |
| --- | --- | --- | --- |
| Instructions in reviewed content | Data cannot set policy; immutable bundle and no reviewer tools | Ignore injected instructions in source, docs, logs, and output | Model may still be influenced; report quality is evaluated, not guaranteed |
| Secret or sensitive path disclosure | Path denylist, local scanner, typed redaction, stop on error | Report exposure without repeating values | Scanner can miss unknown formats |
| Incomplete review presented as full | Hard budgets, all three roles, coverage and status validation | State evidence limits | Models can miss defects in included code |
| Reviewer context contamination | Unique fresh contexts, disabled cross-session memory, no shared scratch | Independent findings | Provider isolation depends on adapter and host evidence |
| Untrusted code execution or exfiltration | Explicit rootless sandbox profile, no host fallback, no network | Do not ask to run code outside profile | Container isolation is not absolute |
| Malicious model output | Local schema and evidence validation, conservative consolidation | Use anchored findings | A schema-valid claim can still be wrong |
| Source or secret retention | Metadata-only audit, no raw transcripts by default | Avoid repeating raw secrets | Hosted provider retention follows its approved terms |
| Unauthorized modification | Host-enforced report-only capabilities and bounded output path | Suggest fixes without applying them | Host implementation must be reviewed |

Every row needs a deterministic test or an explicit residual-risk evaluation before release. The repository now implements file and Git capture, request/policy schema validation, best-effort secret redaction, declarative model capability checks, and metadata-only audit construction. Model dispatch, host-enforced isolation, sandbox execution, and output validation remain planned.
