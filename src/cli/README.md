# Static review CLI

`review.js` asks which harness to use when run in a terminal without runtime flags. It never infers a harness from the model name, installed tools, policy, or current assistant. With `--host-context FILE` (or `TRIVIEW_HOST_CONTEXT`), it asks for current or alternative harnesses: blank/none selects the registered current harness, while multiple choices require role assignments. Chat integrations pass an answer through `--review-harnesses`; CI and piped input require a saved answer or direct runtime selection. See [host integration](../../docs/host-integration.md) and [harness selection](../../docs/harness-selection.md).

Select any compatible implementation with `--adapter-module`/`--adapter-export`, or use `--routes` per reviewer. The following is specifically a Claude Code example: the explicit `--harness claude-code` choice requires a policy approving its hosted provider.

```sh
node src/cli/review.js --request examples/review-request.files.json \
  --policy examples/claude-code-policy.json --harness claude-code --model sonnet --context-window 200000
```

For a Git request, also pass `--repository /absolute/path/to/repository`. The request must identify full base and target commits. To save metadata only, add `--audit-dir /absolute/path/to/audit --retention-days 30`; omit both to disable audit storage. A zero-day retention period stores nothing. The CLI prints the consolidated report as JSON and exits with status 2 for an incomplete review.

## Preflight and output

Run `node src/cli/review.js --help` for all options. Before reviewer invocation, the normal command displays a schema-checked preflight on stderr: selected provider/model/account aliases, hosted-source disclosure, effective control states, exact prepared-request token bounds, budgets, coverage counts, sandbox readiness, audit retention configuration, and adapter limitations. It contains no source, account-directory paths, or reviewer prompts. Required provider or isolation failures refuse review; sandbox readiness can be skipped while static model review continues, with the final report labeled incomplete. Runtime controls are checked again after displaying preflight.

To inspect capability readiness without spending reviewer calls, add `--preflight-only true`. Preflight is then the stdout result; no reviewer session, sandbox command, or audit write starts. Subscription authentication, model metadata, and tokenizer operations may still run. Refused preflight or skipped requested sandbox readiness exits with code 2. The audit configuration is validated here; storage availability is checked when the completed review persists its audit.

Add `--format text` for readable preflight and review reports, or retain `--format json` for automation. The normal JSON review also contains its `preflight` document. Text output preserves findings, validation gaps, reviewer disagreements, coverage, skipped checks, and adapter attribution, and escapes untrusted terminal control characters. Claude's exact served model identity, context capacity, and fixed protocol reserve remain stated assumptions; the preflight exposes those limitations.

| Configuration | Where to set it |
| --- | --- |
| Provider and local/hosted data handling | Policy `dataPolicy`; all selected providers must be allowlisted |
| Current harness or alternatives | `--host-context` with an interactive answer or saved `--review-harnesses`; `--review-assignments` for several choices |
| Explicit adapter or per-role runtime | `--harness claude-code` with `--model` and `--context-window`, or `--routes` with matching policy `roleRoutes` |
| File/line/byte/token/call/time budgets | Complete policy `budgets`; refusal never silently raises a limit |
| Exclusions and sensitive paths | Policy `pathPolicy` and `secretPolicy` before capture |
| Partial reviewer scope | Explicit policy `mode` and `reviewers` |
| Sandboxed execution | Policy `sandbox` opt-in plus `--sandbox-config` |
| Metadata audit retention | Paired `--audit-dir` and `--retention-days` (0–3650) |
| Repo-level overrides onto a shared/base policy | `--policy-overrides FILE`; see below |

Adopters who want to reuse a shared or centrally-maintained base policy, but adjust a few fields per repository, don't have to maintain a duplicate full policy file: `--policy-overrides FILE` layers a small, partial document ([`contracts/schemas/policy-overrides.schema.json`](../../contracts/schemas/policy-overrides.schema.json), example at [`examples/policy-overrides.json`](../../examples/policy-overrides.json)) onto whatever `--policy` loads, covering exactly the fields the configuration roadmap names as the common per-repo tweaks: `budgets` (merged key by key -- only the keys present change), `pathPolicy.excludedPathGlobs` (replaces the base list entirely, so the full exclusion set is always visible in one file), `reviewers` (replaces the base list; `mode` is recomputed from it automatically, so the two can never disagree), and `sandbox` (replaces the whole object, since its fields are interdependent). The merged result is always re-validated against the full policy schema before use (`src/core/policy-overrides.js`'s `applyPolicyOverrides`) -- this mechanism can only ever produce a different *valid* policy, never an invalid one; a malformed or inconsistent override is rejected before anything is merged.

To choose a model and account for each reviewer, use a policy with `dataPolicy.roleRoutes` and a matching runtime file:

```sh
node src/cli/review.js --request examples/review-request.files.json \
  --policy examples/claude-multi-route-policy.json \
  --routes examples/claude-multi-route.json
```

The checked-in example uses Sonnet for code quality and performance and Haiku for security on one Claude subscription. For separate Claude subscriptions, sign in once per profile using `CLAUDE_CONFIG_DIR=/absolute/path/to/profile-a claude auth login` and similarly for profile B. Then set each role's `configDir` in the runtime file and a distinct `adapterId` for each account in both files. Claude Code [documents `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) for running multiple accounts side by side. Credentials stay in those directories; the route files contain only profile paths, model names, and account aliases. The adapter checks each profile with `claude auth status` before preparing source prompts and removes inherited API-key and third-party provider overrides before launching each session.

The core accepts independently supplied adapters for different providers, including local and hosted ones, when every role has an explicit route — this project does not design toward a single harness, by principle, and `src/adapters/model/lm-studio.js` is a real, tested second adapter proving that in practice, not just in architecture. The CLI's single-runtime path (no `--routes`) reflects that generically, not with a CLI-side list of named providers: the explicitly selected convenience is `--harness claude-code --model <id> --context-window <tokens>` for Claude Code; anything else — LM Studio, Codex, Antigravity, a "pi agent," your own rig — goes through `--adapter-module FILE --adapter-export NAME [--adapter-config FILE]`, which dynamically imports your module's named export and calls it with your `--adapter-config` JSON (default `{}`). For example, LM Studio needs no CLI-specific flag at all: `--adapter-module src/adapters/model/lm-studio.js --adapter-export createLmStudioModelAdapter --adapter-config your-lmstudio-config.json`, where that config file (which you write, never commit real hosts to a shared repo) supplies `{"baseUrl": "...", "modelId": "..."}`. [`examples/adapter-template.js`](../../examples/adapter-template.js) is commented starting boilerplate for writing a new one. There is no CLI-level provider-approval check for `--adapter-module`; `src/core/model-preflight.js` already validates `policy.dataPolicy.selectedProvider`/`allowedProviders` generically against whatever `providerId` your loaded adapter actually declares.

The `--routes` multi-role path uses the same generic mechanism per role instead of a CLI-wide flag: each role's entry in the routes file is either `{"kind":"claude-code", "adapterId":"...", "modelId":"...", "contextWindowTokens":..., "configDir":"..."}` or `{"kind":"adapter-module", "module":"...", "export":"...", "config":{...}}`, so one review can route, say, security to a local LM Studio rig while code-quality and performance stay on a Claude Code subscription — mixing providers no longer requires calling `runStaticReview` programmatically. This closes the CLI-level gap the adapter roadmap previously tracked; the policy must still explicitly approve `anthropic-claude-code` in `allowedProviders` whenever any route actually uses the `claude-code` kind, and must approve whatever `providerId` each `adapter-module` route's adapter declares, matching that role's `roleRoutes` entry in the policy the same way a single-runtime `--adapter-module` review already does.

The context window is an explicit caller supplied model limit. The adapter bounds source text using UTF-8 bytes plus a 65,536-token protocol reserve because the subscription CLI does not offer preflight token counting. This reserve and the policy's 100,000-token input budget constrain review size. Live local reviews of synthetic code completed with three distinct sessions and validated reports, including one routed Sonnet/Haiku run. Exact model identity, the configured context limit, and the reserve remain unverified. Tests that call `claude` run locally; deterministic tests run in Podman.

## Optional sandbox verification

Set `sandbox` in the policy to `{"executionRequested":true,"backend":"podman","network":"disabled"}` and supply `--sandbox-config /absolute/path/to/sandbox.json`. The configuration accepts exactly `image` and `command`:

```json
{
  "image": "registry.example/team/checks@sha256:<64 lowercase hex characters>",
  "command": ["/usr/local/bin/python", "/src/check.py"]
}
```

Replace the image placeholder with the digest of a trusted image already installed locally. The CLI displays the image and command on stderr before review begins. Supplying a configuration with execution disabled is rejected. Omit the configuration for a static review; if execution was requested but no command was configured, the report records a skipped check and an incomplete verdict.

Execution supports Linux with a local rootless Podman engine, seccomp, and cgroups v2. `/src` contains only included, sanitized, non-deleted captured files, mounted read-only. It contains no inferred dependency tree or full repository checkout. Select a command that can run with that scope and the dependencies already present in the image. `/scratch` is the writable temporary directory. Limits are one CPU, 512 MiB memory, 64 processes, 64 MiB scratch, 64 KiB captured output, and the policy timeout capped at 300 seconds. Image-defined volumes are ignored, network and proxy forwarding are disabled, and the container runs as a non-root user.

The report's `sandbox` field records status, available profile/image identity, scope, exit code, and scanned output. Audit records retain status and profile/image hashes without command arguments or output. Failed or skipped requested checks produce an incomplete report and CLI exit code 2. Sandbox output is not passed into reviewer prompts.

Missing or unsupported Podman setups receive [official installation guidance](https://podman.io/docs/installation). This version never installs Podman, pulls an image, or falls back to host execution. Container isolation does not prevent sanitized source from reaching an explicitly approved hosted reviewer.

The reviewed subscription profile is Claude Code **2.1.300**. Runtime preflight checks the version before source preparation and refuses other versions until requalified. Inherited Claude/provider logging and model overrides are cleared while the selected profile directory is pinned. Known reported CLI usage that exceeds prepared input or requested output bounds makes the reviewer fail. Context/protocol assumptions remain visible.

## Source and change evidence

Reviewer prompts use format v2 with one-based `N | ` line labels on sanitized content; labels are metadata and are excluded from evidence line counts. `contentSha256` hashes the sanitized unnumbered content. Git inputs provide numeric base/target hunk coordinates for included files, including zero-count deletion hunks and base coordinates for deleted files. Raw patch text and headers are omitted. Deleted-file evidence still contains its captured base content. Files with redactions withhold these coordinates to avoid claiming an original-to-sanitized line mapping. Supplied-file inputs have no Git comparison. Reviewers are instructed to check cited operations and focus on introduced defects; core validation still checks only IDs and line ranges, so manual assessment remains necessary. Added numbering and metadata consume the existing exact-request token budget; limits are never raised automatically.
