# Changelog

This project follows [Semantic Versioning](https://semver.org/): a breaking change to the CLI's flags, a policy/request/report contract schema (see `docs/report-contract.md`), or a documented public behavior bumps the major version once this project reaches 1.0; until then (`0.x`), a minor bump may still include a breaking change, per semver's own pre-1.0 convention — check an entry's own wording rather than assuming minor-version safety while this project is pre-1.0.

This is distinct from the Claude Code CLI version pin (`SUPPORTED_CLI_VERSION` in `src/adapters/model/claude-code.js`, currently `2.1.300`) — that tracks a third-party dependency's version, not this project's own, and is requalified per `docs/requalification-runbook.md` rather than recorded here as a release.

No version of this project has been tagged as a release yet; it has not been published anywhere (see `plan.md` Phase 10/11). Entries below will start once the first tag is cut. Until then, `STATE.md` is the authoritative, detailed log of what changed and why; `RELEASE.md` describes the current state as of the latest commit, not a versioned history.

## [Unreleased]

- Added the current-harness host integration, trusted context schema, chat callback API, and implicitly discoverable `triview-review` skill. The user selects no alternatives to start three isolated current-harness sessions, or selects other harnesses with explicit role assignments. Host context never broadens provider permissions, and failures never switch providers.

- Harness selection is now explicit. Terminal reviews with no runtime flags ask the user which harness to use; CI/piped input refuses missing selection. **Breaking CLI change:** the Claude Code convenience now requires `--harness claude-code` as well as `--model` and `--context-window`. Generic adapter-module and routes flags continue to record an explicit choice. Setup asks before using a detected candidate. See [harness selection](docs/harness-selection.md) for migration and operator guidance.
