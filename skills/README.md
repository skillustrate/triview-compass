# Review skills

When TriView is invoked, ask whether to use the registered current harness or alternative review harnesses, unless already answered for this review. None means three fresh current-harness sessions; several choices require role assignments. Obtain current identity from trusted host context, and preserve the selected execution environment. See [host integration](../docs/host-integration.md); named adapter examples do not select a provider.

Skills provide reusable analysis guidance. They are not runtime permissions, deterministic filters, or sandbox controls.

- `core-review/` — required review process and shared report guidance.
- `security-review/` — threat modeling and security checks.
- `performance-review/` — measurement-led performance analysis.
- `adversarial-input/` — prompt-injection and untrusted-content handling.

Every reviewer receives Core Review. Security receives Security Review and Adversarial Input Review; performance receives Performance Review. The runtime prompt builder sends the concise files in `reviewer-briefs/` for those skill IDs. The full `SKILL.md` files remain reference material and are not included verbatim in model requests. This routing does not skip reviewer agents: every full review starts all three agents. An explicitly requested partial review must be labeled as partial.

`triview-review/` is the host invocation skill. It recognizes code-change review requests in hosts supporting skill discovery, gathers the user's harness selection, and invokes the runtime. It is separate from the four analysis skills and does not enter reviewer prompts.
