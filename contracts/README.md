# Versioned contracts

The JSON Schemas in `schemas/` define provider-neutral v1 contracts for a raw local review request, sanitized review bundle, run policy, adapter capabilities, individual reviewer results, consolidated report, metadata-only preflight report, and privacy-preserving audit record. They use JSON Schema Draft 2020-12 and have no provider or harness dependencies. [Phase 0 decisions](phase-0-decisions.md) defines behavior that cannot be expressed by schema shape alone.

## Contract rules

- Every document carries an explicit `contractVersion`; incompatible changes require a new major version.
- The raw review request stays local until deterministic preflight produces a sanitized bundle. Git input uses two explicit commit IDs; file input carries complete content supplied by a trusted harness.
- Bundle paths are normalized repository-relative paths. Included file content is already sanitized; schemas do not perform redaction or establish trust.
- A full review lists all three reviewer roles. A partial review lists the requested roles and must be reported as partial.
- Each reviewer result identifies its reviewer, model adapter, invocation, opaque context ID, and snapshot hash. The orchestrator assigns one unique context ID per started agent; it is metadata for checking separation, not a provider session token. Result documents are independent; consolidation consumes them only after the sessions complete.
- Schemas validate shape only. Runtime code must additionally verify snapshot identity, included-path membership, line anchors, uniqueness, capability requirements, and privacy constraints.
- Unknown properties are rejected in v1 so misspelled policy fields cannot silently weaken a control.

Runtime validation uses Ajv and deterministic enforcement in core and trusted adapters. The preflight schema records readiness or sanitized refusal; consolidated reports may embed that preflight. Schema shape alone does not prove provider isolation or host enforcement.

`host-context.schema.json` describes trusted application configuration for current and alternative harnesses. It is not review input or a provider permission grant. Selection is validated and bound to effective policy routes before loading adapters; runtime capabilities must then match. See [host integration](../docs/host-integration.md).
