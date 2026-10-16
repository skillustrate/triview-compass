# Source tree

Core runtime modules capture explicit text-file input or two immutable Git commits into a sanitized bundle, prepare and count reviewer requests, dispatch through a provider-neutral adapter, and validate reports. Remaining planned areas:

- `cli/` — user-facing selection, preflight, setup, and review commands.
- `integrations/host-review.js` — trusted current-harness context, user selection, per-role planning, and host UI callback API; see [host integration](../docs/host-integration.md).
- `core/` — snapshot, policy, prompt, dispatch, result validation, and report construction; production adapter enforcement and persistence remain future work.
- `adapters/harness/` — host and coding-harness integrations.
- `adapters/model/` — model-provider integrations.
- `adapters/sandbox/` — Podman and future sandbox backends.

Implement core contracts before adding provider-specific behavior. See [release scope](../RELEASE.md).
