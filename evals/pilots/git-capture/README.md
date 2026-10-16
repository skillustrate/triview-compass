# Real-change pilot — 2026-10-14

The commands here explicitly select the Claude Code reference adapter to reproduce its recorded evaluations. They do not set a default harness; see [harness selection](../../../docs/harness-selection.md) for choosing another adapter. Historical reports retain their original runtime attribution.

Reviewed the Git capture hardening in `15e9ad3..da82cbe` on branch `pilot/real-change-review`. The request pins full commits. The policy sends only `src/core/git-capture.js` and `tests/git-preflight.test.js` (421 lines of target content) to three independent local Claude Code subscription processes using configured Sonnet and a 200,000-token assumed context. The other 38 changed files are explicitly excluded. This is the first hosted repository-source pilot authorized by the user; retained report/configuration contains no credentials or raw prompts.

## Results

- Preflight ready: two included files, 38 excluded, input upper bounds 90,370 / 91,552 / 91,015.
- All three reviewer sessions completed with distinct context IDs. Consolidated advisory verdict: recommend-approval; no Required/Critical findings or unverifiable structural anchors.
- Seven Git preflight tests passed inside `dev-box`, including the missing-object transport refusal and its positive control. This verification used the trusted checkout in Podman; it was separate from the CLI review. The CLI report correctly says sandbox verification was not requested. No reviewed code ran on the host.
- Code quality and security returned no findings. Performance returned one Optional suggestion to batch Git blob access.

## Manual assessment

The performance claim describes the existing loop: size and content use separate Git subprocesses at target lines 182 and 189. The cited range 139–150 covers hashing and function initialization and does not support that claim. It passed structural range validation because those lines exist. Label this an incorrect semantic anchor, not a verified change defect. The subprocess pattern predates the reviewed change; the suggestion has no latency benchmark and does not establish a regression. Keep batching as a possible measured optimization, preserving the size-before-read safeguard, rather than a pilot blocker.

The actual production change sets `GIT_NO_LAZY_FETCH=1`. The new test proves refusal on a missing partial-clone object and proves the configured local transport is reachable when the safeguard is absent. Manual inspection agrees with the narrow change's intent. One real change does not establish reviewer accuracy or broad production acceptance.

## Reproduce

From the repository root, run on the local host:

```sh
node triview-compass/src/cli/review.js --request triview-compass/evals/pilots/git-capture/request.json --policy triview-compass/evals/pilots/git-capture/policy.json --repository "$PWD" --harness claude-code --model sonnet --context-window 200000 --format json
```

Inspect without reviewer calls by adding `--preflight-only true`. The capture limits are explicitly 6,000 changed lines and 2,000 per file because Git capture budgets cover the entire commit before exclusions; reviewer input still contains only the two selected files. Deterministic verification:

```sh
podman exec dev-box sh -lc 'cd /workspace/triview-compass && node --test tests/git-preflight.test.js'
```

## Follow-up

A useful next improvement is explicit numbered source and changed-line context in prompts, plus evaluation of valid-but-wrong semantic anchors and pre-existing findings. These need a dedicated development branch. This pilot changes no product code and does not claim to fix those limitations.

## Evidence-context follow-up

On `improvement/reviewer-evidence-context`, the same committed range and exact two-file policy were rerun through three local Claude subscription reviewers using prompt format v2. All three sessions completed independently, with recommend-approval and no findings or structurally unverifiable anchors. See [the follow-up report](report-evidence-context.json); the original report remains unchanged. The former pre-existing batching suggestion was absent. Manual inspection still finds no blocker in the one-line safeguard and its positive-control test. This rerun demonstrates behavior on this narrow change, not a guarantee of semantic evidence accuracy or absence of missed defects.

The prompt adds numbered sanitized source, Git hunk coordinates, and explicit introduced-change scope. Preflight input bounds increased to 93,833 / 95,015 / 94,478 while staying below the unchanged 100,000-token policy cap. All 98 deterministic tests passed in Podman. The ten-case synthetic suite and baselines passed, including exact evidence at line 43 and unchanged-defect suppression. The CLI review did not request sandbox execution; checkout tests were run separately inside Podman.
