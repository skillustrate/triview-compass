# Reviewer role prompts

When TriView is invoked, ask whether to use the registered current harness or alternative review harnesses, unless already answered for this review. None means three fresh current-harness sessions; several choices require role assignments. Obtain current identity from trusted host context, and preserve the selected execution environment. See [host integration](../docs/host-integration.md); named adapter examples do not select a provider.

This directory contains the three provider-neutral reviewer roles. Each role prompt defines mission, review procedure, and token discipline. It does not grant tool permissions; the harness adapter must start isolated sessions and enforce capabilities.

The orchestrator supplies each role with the same immutable sanitized review bundle and role-appropriate skills. It must never pass one reviewer’s history or output into another reviewer’s context.
