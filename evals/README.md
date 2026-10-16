# Evaluation and validation

The repository keeps reproducible inputs and evidence needed by automated checks. Generated reports, repeated historical runs, and local diagnostics are ignored.

- `cases/` and `fixtures/`: structural evaluation specifications and synthetic inputs.
- `behavior/suite.json`: model-evaluation cases and their oracles.
- `corpus/cases/`: historical real-change inputs and manually dispositioned findings.
- `pilots/git-capture/`: source inputs and reports referenced by corpus case 001.
- `security/threat-coverage.json`: mapping from threats to deterministic tests.
- `evidence/evidence-context-sonnet-2026-10-15-cli2.1.300.json`: model qualification read by release checks.
- `evidence/dependency-audit-2026-10-14.json`: dependency-audit evidence read by release checks.
- `scripts/`: structural validation, release/package checks, scoring, and optional diagnostics.

## Checks

```sh
npm test
npm run check:release
npm run check:package
npm run corpus:score
```

Corpus scoring appends a local ignored `corpus/metrics-log.jsonl`. Read [the corpus guide](corpus/README.md) for manifest and disposition rules. These commands make no model calls.

## Optional model evaluations

Choose a compatible harness and policy explicitly. For the qualified Claude Code reference adapter:

```sh
npm run eval:models -- --harness claude-code --model sonnet --context-window 200000 --output evals/results/new-results.json
```

Create the output directory first. The runner requires a new output file, uses synthetic inputs, and saves scores, latency, numeric usage, and suite/guidance hashes. A real provider call uses your configured account. Historical measurements and small corpora do not establish general accuracy or superiority of three reviewers over one. See [release limitations](../RELEASE.md).
