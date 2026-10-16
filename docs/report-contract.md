# The consolidated report contract

The consolidated report (`contracts/schemas/consolidated-report.schema.json`) is this project's one public, stable output format. External tooling — a CI comment formatter, a dashboard, a triage bot — should read this document and that schema, not `src/` internals, which can change between any two commits without notice.

## Versioning policy

`contractVersion` is currently the literal string `"1.0"` across every v1 schema in this project (request, policy, report, and the rest), not an independent per-schema version. The practical rule, stated plainly rather than rounded up to a looser-sounding promise: **every schema in this family declares `additionalProperties: false`, so almost any change to the report schema is a breaking change for a strict external validator holding its own frozen copy** — adding a new optional field is not "safe" the way it would be under a looser schema, because a consumer validating against yesterday's copy of this schema will reject a report containing a field it doesn't recognize.

Given that, the actual commitment is:

- Any change to `consolidated-report.schema.json`, or to a `common.schema.json` definition the report schema references (`reviewer`, `severity`, `reviewMode`, `safeIdentifier`, `relativePath`, `sha256`), or to the embedded `preflight-report.schema.json`, bumps `contractVersion` — no exceptions carved out for "just additive" changes, because of the `additionalProperties: false` point above.
- `tests/report-contract-stability.test.js` enforces this mechanically: it pins a hash of those three schema files' exact bytes. A change to any of them fails that test with a message pointing back here, forcing a conscious decision (bump the version, update this document and the pinned hash, and say so in `RELEASE.md`) rather than a silent drift.
- External consumers should pin to an exact `contractVersion` string and refuse anything else, rather than trying to tolerate "close enough" reports across versions — this project does not promise forward- or backward-compatible parsing across a version bump, only that a given version's shape is frozen and mechanically enforced not to drift unnoticed.

No version has been bumped past `1.0` yet; this document describes the `1.0` shape.

## Top-level fields

| Field | Meaning |
| --- | --- |
| `contractVersion` | Always `"1.0"` for this version of the contract. |
| `reviewId` | Opaque identifier for this review run. |
| `snapshotSha256` | Hash of the exact sanitized evidence bundle every reviewer saw — the same input, provably, for all three roles. |
| `mode` | `"full"` (all three reviewers) or `"partial"` (an explicitly reduced subset; never a silent reduction). |
| `status` | `"complete"` (every reviewer completed, no sandbox failure), `"partial"` (some reviewers legitimately omitted under an explicit partial-mode policy), or `"incomplete"` (something failed — a reviewer, a requested sandbox check, or a validation step). **Treat anything other than `"complete"` as "do not rely on this report's silence as a clean bill of health."** |
| `verdict` | `"recommend-approval"`, `"request-changes"`, or `"incomplete"`. Advisory only — see the main [README](../README.md#where-this-fits-in-your-review-process); it is never a merge gate by itself. |
| `reviewers` | Per-role outcome: `status` (`completed`/`failed`/`omitted`), which adapter/model handled it, and `invocationId`/`contextId` proving it ran in its own isolated context. |
| `findings` | Confirmed findings, each with `category`, `severity`, cited `evidence` (a file path and either a line range or a diff hunk — never a bare claim with no anchor), an `impact` statement, and `sourceFindings` showing which reviewer(s) raised it (a finding independently raised by more than one reviewer is stronger evidence than one raised by only one). `disagreement: true` flags a finding one reviewer raised that another reviewer's output conflicts with — surfaced, not silently resolved. |
| `unverifiableFindings` | A reviewer's claim that failed core's own structural verification (e.g. a cited line range that doesn't exist in the file) — kept and labeled, not discarded, because a model producing unverifiable claims is itself a signal worth seeing, not noise to hide. |
| `coverage` | Which paths were actually included vs. excluded, and any skipped checks — read this before trusting a report's silence about a file that might not have been reviewed at all. |
| `limitations` | Plain-language caveats that apply to this specific report (e.g. "exact served model identity is unverified") — always read alongside the verdict, not after it. |
| `preflight` | The full preflight document (provider/control/budget disclosure) this run actually used, embedded for audit purposes. |
| `sandbox` | Present only if sandbox verification was requested; `status` plus (depending on status) exit code, scanned output, or a failure/skip reason. A requested-but-failed-or-skipped sandbox check always forces `status: "incomplete"` on the whole report — this cannot be silently downgraded to a clean result. |
| `tokenUsage` | Present only when the adapter actually reports it (most don't yet — see `limitations`); input/output token counts and, optionally, an estimated cost. |

## Cross-field guarantees the schema enforces, not just documents

These are enforced by the schema's own `allOf`/`if`/`then` structure, not left to each consumer to re-derive:

- `verdict: "recommend-approval"` is schema-incompatible with any `Critical`/`Required` finding being present; `"request-changes"` requires at least one. A consumer never has to re-scan `findings` to sanity-check the verdict — the schema already guarantees they agree.
- `status: "complete"` requires `mode: "full"` and every reviewer `status: "completed"`. A partial or failed run can never report as `"complete"`.
- `mode: "full"` requires exactly the three canonical reviewer roles present, in the `reviewers` array — a full review can't quietly drop one.

## Where this is tested

`tests/report-contract-stability.test.js` pins the schema bytes (see "Versioning policy" above). `tests/static-review.test.js` and the rest of the deterministic suite exercise the schema's actual enforcement (verdict/status/finding-severity agreement, reviewer isolation, sandbox-failure forcing incomplete) against real generated reports, not just the schema file in isolation.
