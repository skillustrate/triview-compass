# End-to-end manual test pass — 2026-10-15

Privacy update: personal usernames and user-identifying local path segments in the saved wizard and sandbox transcripts have been anonymized. Numeric IDs, execution outcomes, and model findings are unchanged. These transcripts are privacy-sanitized evidence, rather than byte-for-byte original output.

A full run of every documented user-facing path, live, on this machine: a real authenticated Claude Code CLI (`claude --version` → `2.1.300`, matching the pinned adapter version) and a real rootless Podman sandbox (`podman --version` → `5.7.0`). Nothing here is mocked or simulated — every report below is an actual model response, and the sandbox test actually ran a container. Purpose: this is evidence for the Phase 11 go/no-go decision, not a new phase of implementation work; it exercises the product as a first-time adopter would, start to finish, and records exactly what happened, including the one real bug this pass caught (test C below's finding about `baseRevision`/`targetRevision` naming is a documentation gap, not a code bug — see "What this pass found").

All raw commands, inputs, and outputs are in this directory. Nothing here required code changes; every test passed on the first correctly-formed attempt. Also re-ran the full deterministic suite and both structural checks in `dev-box` to confirm nothing regressed: `npm test` **139/139**, `check:release` and `check:package` (**88 files**) both pass.

## What was tested and the result

| # | Path | Command (abbreviated) | Result |
|---|---|---|---|
| A | `--preflight-only true`, file-based input | `review.js --request ... --preflight-only true` | `status: "ready"`, zero reviewer calls, zero cost — [full preflight](test-A-preflight.json) |
| B | Full review, file-based input, deliberately flawed code | `review.js --request ... --model sonnet --context-window 300000 --format text` | `verdict: request-changes`; shell-injection, swallowed-error, and O(n²) findings — see below and [full report](test-B-buggy-code-review.txt) |
| C | Full review, Git-based input, a real commit pair from this repo's own history | `review.js --request ... --repository . --format text` | `verdict: recommend-approval`, no findings (the diff was a documentation-only fix) — [full report](test-C-git-review.txt) |
| D | `--policy-overrides` narrowing to one reviewer | `review.js ... --policy-overrides overrides-security-only.json` | `status: partial`, `mode` auto-recomputed; only the security reviewer ran, and still caught the injection — [full report](test-D-policy-overrides-review.txt) |
| E | Sandbox verification, real rootless Podman | `review.js ... --sandbox-config sandbox-config.json` | `Sandbox: completed`; captured stdout proves non-root UID and a genuinely blocked network call — [full report](test-E-sandbox-review.txt) |
| F | Metadata-only audit retention | `review.js ... --audit-dir ... --retention-days 30` | One audit record written containing hashes/counts/statuses only, no source or findings text — [record](test-F-audit-record.json) |
| G | Setup wizard end to end, including re-running its own printed command | `setup.js` (piped answers) then the command it printed | Wrote `policy.json` (and nothing else, since one shared assistant/no sandbox/audit were chosen); the printed command ran cleanly against the file it generated — [transcript](test-G-wizard-transcript.txt), [generated policy](test-G-wizard-generated-policy.json) |
| H | GitHub Actions request builder, valid and invalid input | `build-review-request.js <sha> <sha>` | Valid 40-hex SHAs produced the expected request JSON; a malformed SHA was rejected with a clear error and exit code 1, not a silent bad request — [request](test-H-github-actions-request.json) |

## What this pass found

- **Test B is the headline result**: against a small file containing a shell-injection-via-`exec`, a swallowed-error path, and an O(n²) loop, all three reviewers independently found their respective issue — security flagged the injection twice (both the `exec` call and the `../`/leading-`-` edge cases), code-quality flagged the swallowed error and missing return value, and performance flagged the quadratic growth — all in a single ~9-second run.
- **Test E independently confirms a security claim this project already makes rather than just asserting it**: the sandboxed `ping` call failed with `permission denied (are you root?)`, which is the actual observable effect of the rootless container's dropped `CAP_NET_RAW` plus `network: disabled`, not a hand-wavy "network is off."
- **No code defect was found in this pass** — every path was already correct going in; this run is confirmation, not a bugfix pass like the Phase 9 latency/cost measurement was.
- **One documentation gap, now fixed in the same commit as this evidence**: `docs/usage-guide.md` (new) spells out `baseRevision`/`targetRevision` as the exact Git-input field names, because `examples/review-request.files.json`'s sibling `examples/review-request.git.json` already uses them correctly but nothing walked a reader through constructing one from a real commit pair end to end before this pass.

## Reproducing this

Every command above is runnable from a clean checkout with `npm ci --ignore-scripts`, an authenticated `claude` CLI, and (for test E only) a local Podman installation with at least one pulled image. Test B's input file is [here](test-B-input.json) if you want to confirm the findings yourself; its content is synthetic, written for this test, not real project code.
