# Release status and validation

TriView-Compass is a pre-1.0 advisory code-review tool distributed through this GitHub repository. The npm package remains private. Reviews do not automatically mutate code, merge changes, or grant approval.

## Supported integration

Hosts register a compatible adapter and ask users which harnesses to run. No alternatives selects three isolated sessions of the current harness; alternatives require explicit routing. See [host integration](docs/host-integration.md). The qualified reference subscription adapter is Claude Code 2.1.300; other versions require requalification. LM Studio is experimental. Other harnesses require compatible implementations of the adapter contract.

## Reproduce checks

```sh
npm ci --ignore-scripts
npm test
npm run check:release
npm run check:package
npm audit --omit=dev
```

The tested environment is Linux, Node.js 24.18.1, and rootless Podman. Deterministic checks make no model calls. Package validation checks the extracted CLI, schemas, role prompts, skills, and host integration with already-installed dependencies; it does not publish or test registry installation.

Release checks bind the [retained model qualification](evals/evidence/evidence-context-sonnet-2026-10-15-cli2.1.300.json) to the current suite, reviewer guidance, and prompt versions. They also validate threat coverage and the [recorded dependency audit](evals/evidence/dependency-audit-2026-10-14.json). The recorded audit is dated evidence; use the live audit command above for current advisories. See [evaluation instructions](evals/README.md) for fresh provider evaluations.

## Empirical accuracy across real changes (Phase 7)

The retained [20-case corpus](evals/corpus/README.md) spans seven ecosystems. Historical manual dispositions recorded 7/8 confirmed blocking findings, detection in 4/4 known-defect-present cases, and no findings in 3/3 known-clean cases. One of two rejected findings had an incorrect anchor. Another known-fix case produced a clean report despite a residual gap found by independent investigation.

These small, security-heavy samples do not establish general accuracy. True findings outside the selected change, incorrect citations, and missed defects remain possible. Inspect evidence and changed logic before acting on a report. Repeated historical run artifacts are retained locally and excluded from the current repository tree; fixtures, corpus inputs, and required release evidence remain versioned.

## Limitations

- Model truthfulness and completeness are unverified; reports support human decisions.
- Secret scanning is best effort. Unrecognized secret formats can pass through.
- An explicitly allowed hosted provider receives sanitized source; provider retention remains a separate trust boundary.
- Sandbox verification includes only captured, sanitized, non-deleted files, without a full checkout or dependency tree. Failed sandboxing never falls back to host execution.
- Linux is qualified; macOS and Windows are untested.
- GitHub Actions examples require adopter-provided installation and compatible CI model adapters.
- No fresh live-provider qualification is implied by repository cleanup or deterministic tests.

See [SECURITY.md](SECURITY.md), the [capability matrix](docs/capability-matrix.md), and the [report contract](docs/report-contract.md).
