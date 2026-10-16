# Choose your harness

TriView-Compass has no fixed default provider. When a host integration invokes it, the assistant asks whether to use the current harness or alternatives. No alternatives means three fresh sessions on the registered current harness. The host supplies trusted identity and adapter configuration; installed binaries and example policies do not establish that identity. See [host integration](host-integration.md) for setup, implicit invocation, and the current-harness flow.

## Interactive reviews

From a terminal, run:

```sh
node src/cli/review.js --request request.json --policy policy.json
```

Without registered host context, the standalone CLI asks which adapter to use before loading an adapter or starting preflight. Enter a compatible adapter module path, choose `routes` to supply per-reviewer configuration, or explicitly choose `claude-code` for that reference adapter. There is no preselected answer. Enter `cancel` to stop. Prompts go to stderr so stdout remains the report.

For guided configuration, run `node src/cli/setup.js`. Detection is optional and only offers a candidate: the user must confirm it before use. Declining a candidate lets the user configure another adapter. The generated command records the choice explicitly.

## Scripts and CI

Non-interactive input and CI never assume an unanswered question means none. A host can pass `--host-context FILE --review-harnesses none` after obtaining that answer in chat. Alternatively, supply exactly one direct runtime selection:

```sh
# Any compatible harness, through its adapter implementation
node src/cli/review.js --request request.json --policy policy.json \
  --adapter-module /path/to/adapter.mjs --adapter-export createAdapter \
  --adapter-config /path/to/config.json

# A user-chosen runtime for each reviewer
node src/cli/review.js --request request.json --policy policy.json --routes routes.json

# Only when the user chooses the shipped Claude Code adapter
node src/cli/review.js --request request.json --policy examples/claude-code-policy.json \
  --harness claude-code --model sonnet --context-window 200000
```

`--model` and `--context-window` alone no longer imply Claude Code. Update older commands by adding `--harness claude-code` if that remains your choice, or replace the runtime flags with your adapter or routes configuration. Explicit flags are a saved choice and are not prompted for again.

The shipped model adapters are Claude Code (hosted) and LM Studio (local, experimental). Other harnesses require a compatible adapter; mentioning Codex, Antigravity, or another tool is not a claim that an adapter ships for it. See [the adapter contract](../adapters/README.md) and [adapter template](../examples/adapter-template.js). Harness-specific examples document that adapter, not a recommendation or default.

The policy must separately allow the chosen provider and its local or hosted data handling. Selecting a harness never bypasses that check. Runtime failure never switches providers automatically. Sandbox location is a separate execution choice; do not infer local execution or a remote host from the chosen harness.

## AI assistants operating this tool

Use the bundled [TriView review skill](../skills/triview-review/SKILL.md). Ask: “Use this harness for all three reviewers, or choose other harnesses? None means use the current harness.” Reuse an answer already supplied for this review. The current harness must come from trusted host context. One chosen alternative handles all roles; several choices require explicit role assignments. Ask for model/account and execution details when needed. Report unavailable adapters or runtimes instead of substituting another harness. Keep the coordinating conversation separate from the reviewer sessions.

Historical evaluation artifacts retain the harness and commands used at the time. The model qualification script is specifically for the Claude Code reference adapter and requires `--harness claude-code`; its results do not qualify every harness.
