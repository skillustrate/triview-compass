# Getting started in 5 minutes

This page assumes nothing about this project's architecture — it's a straight path from a checkout to your first review report. For the *why* behind any of this, see the main [README](../README.md) afterward.

## Before you start

- **Node.js 20 or newer.** Check with `node --version`.
- **Your choice of review harness and model.** Use a compatible adapter and its authentication/configuration. The shipped examples cover Claude Code and LM Studio; other tools require an adapter. An installed CLI alone does not establish working authentication. See [harness selection](harness-selection.md).
- **Linux.** This project's own deterministic checks and live reviews only run on Linux today — see the main README's "Linux only" note.

For an assistant-integrated review, install the bundled `skills/triview-review/` in your host's skill directory and configure trusted host context once. On a review request, the assistant asks whether to use the current harness or alternatives. None uses the current harness for three fresh reviewer sessions. See [host integration](host-integration.md); standalone configuration starts below.

## 1. Install dependencies

```sh
npm ci --ignore-scripts
```

This installs exactly what's in `package-lock.json`; no scripts run during install.

## 2. Generate your configuration

```sh
node src/cli/setup.js
```

This asks a short series of yes/no questions — which reviewers you want, whether your code can go to a hosted model or must stay local, whether you're using one assistant or several — and writes a working `triview-setup/policy.json` for you. You never have to hand-write JSON against a schema to get started. See the setup wizard's own section in the main README if you want the full question-by-question reference before running it.

When it finishes, it prints the exact command you'll run in step 4. Copy it somewhere; you'll need it in a moment.

## 3. Point it at something to review

The simplest first run doesn't even need a Git repository. Save this as `my-request.json`:

```json
{
  "contractVersion": "1.0",
  "input": {
    "kind": "files",
    "files": [
      { "path": "src/example.js", "changeType": "modified", "content": "export const answer = 42;\n" }
    ]
  }
}
```

(A real [`--repository PATH`](../src/cli/README.md) Git-based run works the same way once you're past this first try — that takes a base/target commit pair instead of inline file content.)

## 4. Run the review

Use the command printed by setup; it records your harness choice explicitly. To choose at review time instead, run this from a terminal:

```sh
node src/cli/review.js --request my-request.json --policy triview-setup/policy.json
```

It asks for your adapter module or routes file, or lets you explicitly choose the Claude Code reference adapter. Your choice must match the provider and data handling allowed by your policy. Add `--format text` for a readable report. CI requires explicit runtime flags and never prompts.

## 5. Read the report

Before trusting anything in it:

- Check `status`. Anything other than `"complete"` means something didn't finish cleanly — read `limitations` and any `"failed"`/`"omitted"` reviewer entries before looking at `findings` at all.
- Each finding cites a file and either a line range or a diff hunk — open that exact location and confirm the claim before acting on it. See the main README's "Before acting on a finding" checklist.
- `verdict` is advisory, never a merge gate. See "Where this fits in your review process" in the main README.

The full field-by-field reference, including what's guaranteed by the schema versus just documented, is in [the report contract](report-contract.md).

## Choosing a harness

Every harness is a user choice. The wizard may offer to detect a candidate, but it asks before using it. You can decline and supply your own adapter module and factory export. See [harness selection](harness-selection.md) for generic and per-role configurations and [the adapter template](../examples/adapter-template.js) for building an integration.

## Running this automatically on pull requests

Once the above works locally, see [`examples/github-actions/`](../examples/github-actions/README.md) for a copy-into-your-repo workflow that posts the report as an advisory PR comment — not a merge gate. It has two things you'll need to fill in yourself (where to install this project from, and your CI-reachable model adapter), explained plainly in that README rather than glossed over.

## If several repos should share one policy

See `--policy-overrides` in [`src/cli/README.md`](../src/cli/README.md) — it lets you layer a few repo-specific tweaks (budgets, excluded paths, reviewer subset, sandbox opt-in) onto a shared base policy instead of maintaining a full duplicate per repository.

## More examples

[The usage guide](usage-guide.md) covers Git-based review (the shape a real CI job uses), shared policies across repos, sandbox verification, and audit retention — each one a command actually run against this project, with the full output in its evidence (local historical archive).
