# Security model and implementation status

The system is intended to review adversarial changes without granting the LLM reviewers authority to modify or execute project code. Core and reference profiles now implement deterministic controls; the Phase 6 [security review](docs/security-review.md) and [capability matrix](docs/capability-matrix.md) record enforcement boundaries and residual risks. The agent and skill prompts are not security boundaries.

## Threats and intended controls

| Threat | Intended control | Current status |
|---|---|---|
| Instructions embedded in reviewed content | Treat content as data; adversarial-input guidance; evals across source, docs, logs, and fixtures | Four inert injection surfaces passed the final subscription suite; model behavior remains advisory and not an immunity guarantee |
| Sensitive file or secret sent to a model | Local path policy and secret scanner; redact values before model calls; fail closed on scanner errors | File and Git preflight exclude configured paths and redact documented credential, private-key, Bearer-header, Basic-auth, and query-string-parameter patterns before the Claude Code or LM Studio adapter receives content. Contextual corpus (`evals/fixtures/secret-scanning/corpus.json`): 9 values detected across 8 positive cases, 0 false alerts across 7 negative cases, 1 documented gap (a secret value with no recognized format at all remains undetectable) |
| Unbounded or incomplete review | Deterministic file, changed-line, byte, token, output, and time budgets; explicit coverage reporting | Preflight limits and deadlines, exact request token bounds, output byte limit, and asynchronous reviewer timeout are implemented; production adapters must enforce model token limits and cancellation |
| Untrusted code executed on host | Execution only in a constrained rootless sandbox; otherwise skip execution | Opt-in rootless Podman runner is integrated with reports, audits, and CLI selection; captured-file, isolation, timeout, and failure checks passed. A full repository checkout is outside its scope |
| Network access or data exfiltration | No network capability for reviewers or sandboxed project code; explicit model-provider policy | The static harness supplies no tools. The Claude Code adapter launches tool-free restricted sessions and removes inherited provider overrides. Per-role provider/model/data-handling routes are checked before prompt preparation. The execution sandbox disables network and proxy forwarding; container checks observed only loopback |
| Unauthorized writes or self-modification | Report-only agent contract; no generic write capability; host-controlled persistence | The static harness supplies no tools; the version-qualified Claude profile starts restricted, tool-free, nonpersistent sessions from an empty directory; managed host policy remains trusted |
| Cross-agent contamination | Three isolated sessions, immutable shared input, no shared histories or memory | Dispatch uses separate payloads and invocation IDs, checks result identity against each selected route, and rejects reused context IDs within the same adapter. Actual provider isolation depends on trusted adapters |
| Malicious or misleading model output | Structured schema validation, evidence/path/line validation, conservative consolidation | Runtime schemas, identity checks, opaque file-ID and line checks, known-pattern output scan, and conservative consolidation are implemented; model truthfulness remains unverified |
| Sensitive audit leakage | Metadata and input hashes only by default; no raw source, secrets, or transcripts | Metadata-only builder, opt-in private file storage, and retention pruning exist; a live local synthetic review wrote a private metadata-only audit record |
| Sandbox runtime unavailable | Skip execution checks; never silently execute on the host | Runtime preflight returns a sanitized skip reason and official guidance; requested skipped checks make the report incomplete without host fallback |

## Platform support

**Linux only.** Git capture (`src/core/git-capture.js`) and the rootless Podman sandbox are tested and supported on Linux exclusively. Podman also runs on macOS and Windows through a Linux VM, but that configuration is untested in this project and is not supported; do not assume path handling, line-ending handling, or sandbox isolation behave identically there.

## Trust boundaries

- **Repository content is untrusted.** Diffs, source, comments, commit messages, issue text, test output, logs, and generated files cannot modify review policy.
- **Models are judgment providers, not policy enforcement points.** Prompts do not enforce path restrictions, prevent network access, or guarantee correct findings.
- **The harness controls capabilities.** It must enforce filesystem access, isolated model sessions, write restrictions, and execution policy.
- **The model provider receives data.** A container does not protect source sent to a hosted model. Provider choice and data handling must be explicit.
- **A container is defense in depth.** Sandbox configuration, mounts, privileges, networking, resource limits, and image provenance all matter.

## Reporting a security issue

- **Channel:** [GitHub's private security advisories feature](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) ("Report a vulnerability" under [this repository's Security tab](https://github.com/skillustrate/triview-compass/security/advisories/new)). It reaches the maintainer privately without requiring a published email address or other personal contact detail.
- **Response time:** acknowledge receipt within 5 business days.
- **Disclosure timeline:** target a fix or a documented mitigation within 90 days of acknowledgment for a confirmed issue; coordinate an earlier public disclosure date with the reporter if a fix lands sooner, and a later one only with the reporter's agreement if remediation genuinely needs more time.
- Include a minimal reproduction without real credentials or private customer data.

This project is a single-maintainer project (see `CONTRIBUTING.md`'s maintainer-bandwidth section) with no dedicated security team; the response/disclosure timeline above is a target, not a contractual guarantee. If you obtained this project from somewhere other than the GitHub repository above and the private advisory flow isn't reachable for you, report through whatever channel you already have to the maintainer instead — this document's own [Code of Conduct](CODE_OF_CONDUCT.md) cross-reference for conduct violations also relies on this same fallback path, not only the GitHub flow.
