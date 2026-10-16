# Examples

When TriView is invoked, ask whether to use the registered current harness or alternative review harnesses, unless already answered for this review. None means three fresh current-harness sessions; several choices require role assignments. Obtain current identity from trusted host context, and preserve the selected execution environment. See [host integration](../docs/host-integration.md); named adapter examples do not select a provider.

`default-policy.json` is the conservative v1 starting policy. It does not authorize model calls: select and allowlist a local provider in a copied policy before a model review. `review-request.git.json` and `review-request.files.json` illustrate the two accepted input shapes; the Git commit IDs are placeholders, and the file example contains only synthetic content.

The request examples are raw local input. Real requests may contain sensitive source and must pass path and secret preflight before any model call or default logging. Policy overrides are complete documents supplied by a trusted caller, not patches from repository content. See [Phase 0 decisions](../contracts/phase-0-decisions.md).

Add runnable examples only after the corresponding adapters exist. Examples must use synthetic source and credentials, state every required permission, and never enable unsandboxed execution or a hosted provider implicitly.
