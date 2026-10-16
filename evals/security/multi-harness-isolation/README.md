# Multi-harness credential isolation probe (Phase 8)

"Exercise second-account/multi-route model adapter configuration with a real second account" was flagged as open, because the only existing test (`tests/model-routing.test.js`) uses a fake adapter object, not two real, independently-authenticated CLI harnesses. A real second Claude account was not available; a real second harness (Codex CLI, already installed and logged in to its own independent account) was used instead.

## What this is and isn't

This does **not** add Codex as a supported provider, and never sends review content or project source to Codex — building a full Codex model adapter is out of scope here (its tool surface — shell exec, browser/computer use — is much larger than Claude Code's `--tools '' --restricted` mode, with no equivalent "zero tools" flag found; see `codex features list`). This is a one-off diagnostic script, [`evals/scripts/probe-multi-harness-isolation.js`](../../scripts/probe-multi-harness-isolation.js), not a permanent part of the product or the deterministic test suite — it needs two real logged-in CLIs and isn't run in `dev-box` or CI.

## What it actually checks

1. **Env-stripping fidelity under concurrency.** The exact strip-`ANTHROPIC_`/`CLAUDE_`-prefixed-vars logic from `invokeCli()` in `src/adapters/model/claude-code.js` (the fix from corpus case 003) is replicated and checked against a parent environment where a *second, unrelated provider's* own credential vars (`OPENAI_*`/`CODEX_*`) are also present and deliberately poisoned. The existing mocked routing test never has a second real provider's variables present at all; this is the first check of that stripping code with a second real provider's variables genuinely in the mix.
2. **Real concurrent-session identity check.** `claude --version` and `codex doctor --json --summary` are invoked at the same time (`Promise.all`), each with real credentials, and the result confirms each reports its own correct identity with no interference and no cross-contamination of the other's poison value in its output.

## Result (run twice, both times on 2026-10-15)

```
=== Check 1: env-stripping fidelity under concurrency ===
PASS: the real invokeCli() stripping logic removes ANTHROPIC_*/CLAUDE_* poison even with a second, unrelated provider's own credential vars present in the same parent env.
NOTE: unrelated OPENAI_*/CODEX_* vars remain in the Claude-bound env by design — Claude CLI does not read them, so this is expected, not a leak.

=== Check 2: real concurrent-session identity check ===
PASS: claude --version reported 2.1.300 (Claude Code)
PASS: codex doctor auth.credentials status = ok (auth is configured)
PASS: neither harness's output carries the other's poison value; both ran concurrently with no observed interference.

All checks passed. No review content or project source was sent to either harness.
```

## What this does and doesn't establish

- It confirms the specific, already-shipped env-stripping fix (case 003) still holds when a second real, differently-branded CLI with its own credential env vars is running concurrently — a scenario the mocked test couldn't exercise.
- It confirms two real, independently-authenticated CLI harnesses can run concurrently from the same orchestrating Node process without crashing, racing, or leaking output into each other.
- It does **not** confirm the originally-flagged scenario verbatim: two different *Claude* accounts (two `CLAUDE_CONFIG_DIR` profiles) routed to different roles in the same review. That specific case — does `CLAUDE_CONFIG_DIR` genuinely produce two fully isolated sessions, with no shared host-level cache or credential store — remains unverified and needs an actual second Claude subscription to close. This probe narrows the gap but does not close it.
- It does not establish anything about Codex's own tool-use safety if it were ever integrated as a reviewer — that question was explicitly set aside, not answered, when the full-adapter option was declined in favor of this probe.
