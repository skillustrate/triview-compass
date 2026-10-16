# V1 security review — 2026-10-14

Scope: deterministic orchestration, reference adapters, source/output scanning, sandbox profile, audit storage, and trusted installation/update boundaries. This is the implementation security review for a private advisory preview; it is not an independent penetration test or a provider-backend audit.

## Findings and resolutions

| Finding | Resolution | Evidence |
| --- | --- | --- |
| Missing objects in a partial clone could trigger a transport command or network fetch during capture | Set `GIT_NO_LAZY_FETCH=1`; missing objects refuse capture without fallback | Real synthetic Git fixture asserts no transport executes; positive control proves the transport is reachable |
| Adapter metadata/auth/tokenizer operations could wait indefinitely before reviewer dispatch | Shared handshake/recheck deadline and abort signals; Claude version/auth subprocesses have a 10-second cap and forced kill | Stalled-adapter refusal plus a real auth-child test verifies forced termination despite ignored SIGTERM |
| Known secret patterns could appear in visible capability metadata | Scan the complete preflight after schema validation; withhold unsafe metadata | Secret-shaped model-ID test produces only a sanitized refusal |
| Local-only HTTP adapter could accept public endpoints or follow redirects | Restrict to localhost/literal private network; prohibit redirects on metadata and review requests | Constructor and request-option fixtures verify refusal and no redirects |
| Inherited Claude logging/provider/model override variables could weaken the fixed review profile | Clear inherited `CLAUDE_*`/`ANTHROPIC_*`; restore only fixed output/traffic controls and the pinned profile directory | Separate-account environment tests verify overrides and trace directories are absent |
| Reported CLI usage could exceed requested invocation budgets | Reject known aggregate usage above the prepared input bound or requested output cap | Over-budget reported-usage test produces an incomplete report |
| Untested CLI upgrades could silently change enforcement | Refuse CLI versions other than the reviewed 2.1.300 profile before source preparation | Unsupported-version fixture and live current-version preflight |
| Model returned a generic missing-tests suggestion on clean source | Clarify that omitted tests and unspecified input contracts are not evidence of defects | First evaluation and diagnostic reproduced it; revised clean cases passed |
| Model returned unverifiable evidence on injected auxiliary text | Constrain structured output to supplied IDs, actual line bounds, and loaded skills; retain local validation | Earlier run safely became incomplete; targeted and final suite passed |
| Terminal text could conceal content using control sequences or bidirectional controls | Escape those characters in readable reports | Renderer fixture retains findings and exposes escaped controls |

## Threat coverage and residual risks

The machine-readable [threat coverage](../evals/security/threat-coverage.json) maps every threat to named deterministic tests, relevant behavior cases, and a stated residual risk. `npm run check:release` validates those references; `npm test` executes the tests. Actual sandbox probes verify UID, mount write refusal, scratch, loopback-only interfaces, cgroup limits, timeout, output scanning, report/audit integration, and unavailable image handling.

The remaining risks are explicit: unknown secret formats; incorrect but schema-valid model claims; trusted CLI/engine/managed host configuration; provider-side isolation and retention; empirical token reserves; private servers that proxy data; kernel/container vulnerabilities; and trusted audit-path ownership. The three-call budget bounds orchestrated reviewer invocations, not internal provider requests, billable usage, or subscription quota. A model alias can change at the provider; evaluation metrics record observed served IDs after invocation. No finite synthetic sample proves general accuracy, injection immunity, or exact token capacity.

No source modification, merge, publication, provider switch, Podman installation, image pull, or host execution fallback is performed automatically. Git object capture runs only trusted host Git commands against a trusted repository/configuration. Evaluated source is never passed to a host shell or executed by model evaluations. The separate explicit sandbox command remains the only reviewed-code execution path.

## Installation and update process

Install from a trusted checkout with the committed lockfile using `npm ci --ignore-scripts`. Keep installed role/skill/adapter/schema files separate from the untrusted repository being reviewed. Review changes to those files as executable policy changes; record their hashes and rerun deterministic tests, model cases, runtime probes, and dependency audit before updating the trusted installation. Preserve complete provider policy and avoid copying credentials into config/fixtures/artifacts.

CLI version pinning requires requalification before accepting a new Claude release. Podman images are selected by immutable digest and must already exist locally; review the image provenance and keep the kernel/engine patched. Use private audit directories controlled by the caller; a hostile host or local administrator is outside this boundary. The package remains private and publication requires a separate user decision.

## Evidence-context follow-up

The real-change pilot demonstrated an in-range but semantically wrong anchor and a suggestion about unchanged code. Prompt format v2 adds explicit source numbers and numeric Git hunk context to guide cited operations and introduced-change relevance. Hunk parsing retains only numeric headers; raw patch source/path headers are not copied into prompts; deleted-file base evidence retains its existing explicit scope. Redacted files withhold context instead of using coordinates that may have shifted. Tests cover additions, modifications, deletion-only hunks, deleted files, identical renames, old-source/path privacy, and multiline redaction. Semantic fixture oracles require the expected narrow defect range; this remains an advisory quality check rather than deterministic proof of a model claim.

The initial expanded run detected the line-43 defect but failed the pre-existing-defect case: two roles interpreted `full` as a whole-file audit. The final prompt explicitly states introduced-change scope and defines `full` as reviewer coverage. The focused follow-up returned no findings in both modes. Earlier metadata remains in `evals/evidence/evidence-context-initial-sonnet-2026-10-14.json`; it is not substituted for final current-prompt qualification.
