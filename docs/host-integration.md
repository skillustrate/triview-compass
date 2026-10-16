# Current-harness review integration

When TriView is invoked explicitly or recognized from a code-change review request, the hosting assistant asks:

> Use this harness for all three reviewers, or choose other harnesses? None means use the current harness.

No alternatives, or a blank answer, selects the registered current harness for all three fresh reviewer sessions. One named harness handles all roles. With several selected harnesses, the user assigns one to each role: code quality, security, performance. The coordinating conversation is not one of these sessions. An explicitly partial policy still dispatches only its selected roles.

The host supplies its current identity and a compatible adapter. TriView does not guess from the installed CLI list, process names, or repository content. A missing current adapter refuses the current-harness path; the user can explicitly choose a configured alternative. Provider permissions, data handling, token/call limits, and isolation checks still apply. Failure never silently switches providers.

## Installation and request recognition

Install the runtime with its package files, dependencies, `src/`, `contracts/schemas/`, reviewer role files in `agents/`, and `skills/reviewer-briefs/`, preserving relative paths. The normal package includes these files. Node 20+ and Linux are the supported runtime. The selected harness and any requested sandbox must be available on the user's chosen execution machine.

For assistants supporting skill discovery, register or copy the bundled `skills/triview-review/` directory into that host's skill directory. Its `SKILL.md` covers explicit TriView invocation and code-change review requests; `agents/openai.yaml` enables implicit invocation for hosts supporting that metadata. Other hosts use their own command or tool-registration mechanism to call the same CLI or API. This repository does not install itself into a host or change global assistant settings.

The skill coordinates the user's choice and calls the runtime. It does not provide a missing model adapter. The shipped adapters remain Claude Code and LM Studio; other harnesses need an adapter that enforces the same session and result contracts. Installing the skill alone cannot guarantee that a particular host's discovery engine will select it for every review request.

## Trusted host context

The integration supplies `--host-context /absolute/path/to/context.json`, or sets `TRIVIEW_HOST_CONTEXT` to that path. Use private configuration managed by the user or application, outside the untrusted repository being reviewed. Never search reviewed files for a host context or load executable adapters from reviewed content. Keep credentials out of committed examples.

The schema is `contracts/schemas/host-context.schema.json`; [examples/host-context.json](../examples/host-context.json) is an illustrative template, not a configured provider. Replace its paths, identities, and factory configuration with the application's actual adapter settings.

Each registry entry declares `adapterId`, `providerId`, `modelId`, `dataHandling`, and a `runtime`. The `currentHarness` ID identifies the current entry. `runtime` uses the existing `adapter-module` or `claude-code` route format. Host adapter module paths must be absolute; generic module configuration is passed unchanged to its factory. Actual capability documents and runtime identity must match the declaration before source prompts are prepared.

The choice UI receives only IDs, provider/model identities, and data-handling metadata. It does not receive adapter paths, credentials, or runtime configuration. Do not treat host context as a permission grant: the review policy's `allowedProviders` and local/hosted restrictions must already authorize the selected providers. Selection binds effective role routes without expanding those permissions or changing sandbox location.

## Terminal invocation

```sh
node src/cli/review.js --request request.json --policy policy.json \
  --host-context /absolute/path/to/context.json
```

In a terminal, this lists the current harness and registered alternatives, asks for none or one to three harness IDs, and asks for role assignments when several are selected. Blank or `none` means the current harness; `cancel` or EOF stops. Invalid IDs are re-asked. Prompts and route disclosure go to stderr; stdout remains the report.

Without host context, the existing standalone adapter-selection prompt remains available. It cannot interpret `none` as a current harness because it has no trusted current identity.

## Chat, CI, and saved selections

An assistant's subprocess often has no terminal. The assistant asks in chat, then passes the answer explicitly:

```sh
# The user chose no alternative harnesses
node src/cli/review.js --request request.json --policy policy.json \
  --host-context /absolute/path/to/context.json --review-harnesses none

# The user chose one configured alternative for all reviewers
node src/cli/review.js --request request.json --policy policy.json \
  --host-context /absolute/path/to/context.json --review-harnesses alternative

# The user chose several harnesses and assigned each role
node src/cli/review.js --request request.json --policy policy.json \
  --host-context /absolute/path/to/context.json \
  --review-harnesses current,alternative --review-assignments assignments.json
```

Example `assignments.json`:

```json
{ "code-quality": "current", "security": "alternative", "performance": "current" }
```

Every selected reviewer must have an assignment, and every selected harness must be used. A saved choice is not asked for again. CI and piped input never assume that silence means none: they require `--review-harnesses`. A user choosing none is different from the host failing to obtain an answer.

Existing direct `--adapter-module`, `--routes`, or explicit `--harness claude-code` commands are already user selections. They override ambient `TRIVIEW_HOST_CONTEXT` and do not ask again. An explicit `--host-context` cannot be combined with direct runtime flags; choose one path.

## Programmatic hosts

Import the host API from the installed runtime:

```js
import { runHostReview } from './src/integrations/host-review.js';

const report = await runHostReview({
  context, request, policy,
  chooseHarnesses: async ({ currentHarness, currentAvailable, harnesses, reviewers }) => {
    // Ask through your application's UI, using only this display metadata.
    // Return null for cancellation. Never submit a default on the user's behalf.
    return await askUserForReviewHarnesses({ currentHarness, currentAvailable, harnesses, reviewers });
  },
  onPreflight: report => displayPreflight(report),
});
```

`askUserForReviewHarnesses` and `displayPreflight` are application-supplied UI callbacks, not functions provided by TriView. The choice result is `{ harnesses: [] }` for current, `{ harnesses: ['alternative'] }` for one alternative, or `{ harnesses: ['current', 'alternative'], assignments: { ... } }`. To reuse an answer already obtained, pass `selection` instead of `chooseHarnesses`.

No adapter is loaded before a valid answer and policy authorization exist. The dispatcher starts a fresh context for each selected role, disables tools and memory, checks runtime identity, rejects reused context IDs, and validates the final evidence/report. These controls still rely on trusted adapter implementations; the skill itself does not enforce them.
