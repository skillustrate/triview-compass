## What this changes and why

<!-- The why matters more than the what here -- see CONTRIBUTING.md. -->

## Checklist

- [ ] `npm ci --ignore-scripts && npm test && npm run check:release && npm run check:package` all pass (run inside the project's Podman container)
- [ ] New behavior has a new deterministic test, not just a description here
- [ ] If this touches `src/core/`, a contract schema, or adds a provider/harness-specific assumption anywhere outside `adapters/`/`src/adapters/`: explain why, since this project is provider-neutral and report-only as a hard rule, not a preference
- [ ] If this changes `contracts/schemas/consolidated-report.schema.json`, `common.schema.json`, or `preflight-report.schema.json`: updated `docs/report-contract.md` and `tests/report-contract-stability.test.js`'s pinned hash, and said so below
- [ ] For a non-trivial change (new adapter, new CLI flag, schema change): linked the issue where this was discussed first

## Anything a reviewer should know that isn't obvious from the diff
