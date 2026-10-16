# Adapter contracts

The core reviewer package must not depend on a specific coding harness, model provider, or sandbox engine. Adapters implement the interfaces described here and in [architecture overview](../README.md#architecture-at-a-glance).

## Harness adapter

Supplies a fixed change snapshot and approved project context. Reports its enforcement capabilities for file access, writes, execution, network, isolated sessions, and approval prompts. Instructions in agent prompts do not count as enforcement.

## Model adapter

Invokes a configured model with bounded input/output. Reports provider/model identity, data handling configuration, context/output limits, structured-output support, and usage metadata. Provider fallback must be explicit; source must never be sent to an unconfigured provider.

## Sandbox adapter

Implements the declared sandbox profile: immutable source mount, bounded scratch area, non-root execution, disabled project-code network by default, no host credentials or runtime sockets, resource/time limits, bounded output, and verified image/runtime identity.

The application accepts a trusted `sandboxAdapter.runVerification({ policy, bundle, image, command, scan })` interface. The host supplies the backend; the CLI uses `createPodmanSandboxAdapter()`. Results satisfy the report's sandbox schema, are detached and scanned locally, and never enter reviewer prompts. Backend exceptions or malformed results become failed checks. The v1 Podman backend reconstructs only included sanitized non-deleted files, reports that scope explicitly, and requires an already-local digest-pinned image. Command and image configuration cannot supply runtime overrides.

## Adapter capability matrix

Every adapter release must document which controls are enforced, which are unavailable, which require user configuration, and what safe behavior occurs when a required capability is missing. Unsupported capabilities must not be represented as equivalent protections.

## Pre-dispatch handshake

`src/core/adapter-handshake.js` defines a provider-neutral pre-dispatch interface. The trusted harness and model adapters each implement `getCapabilities()` for their declared capability document and `verifyRuntime()` for a fresh document reflecting effective settings. Both documents must satisfy `adapter-capabilities.schema.json`; identity must stay fixed between them. A declared `configurable` control passes only when runtime verification reports it as `enforced`. The core checks the selected provider, local or hosted handling, no-tool and isolation controls before giving prompt text to the model adapter.

The core `prepareReviewInputs()` entry point builds one complete prompt string per selected role from the sanitized frozen bundle, fixed role files, and concise reviewer briefs for the required skills. It replaces repository paths with opaque file IDs and keeps the ID-to-path resolver local. The model adapter implements `prepareRequest({ role, prompt, snapshotSha256, providerId, modelId, maxOutputTokens })` and returns the exact UTF-8 string to be sent later. It then implements `countInputTokens({ role, payload, modelId })` and returns `{ upperBound, conservative: true }` for that same serialized string, including provider wrappers and static instructions. The handshake rejects missing, invalid, or over-budget bounds and returns the immutable serialized requests with their hashes. It does not send them.

The dispatcher calls `invokeReview({ role, invocationId, payload, payloadSha256, inputTokenUpperBound, maxOutputTokens, freshContext, memoryEnabled, tools, signal })` once per selected role, using the exact prepared payload. The adapter must create a new provider session, disable memory and all tools, enforce the output limit, honor abort, and return a `reviewer-result.schema.json` result with the supplied invocation ID and its distinct provider context ID. A reviewer failure must not be retried silently. The core validates the returned result and marks failures or unverifiable evidence incomplete.

Core pins the policy version during preparation and rechecks effective adapter capabilities after payload preparation, before starting any reviewer. If the policy, provider, adapter identity, data handling, or required controls change, dispatch stops before a model call.

These methods belong to trusted, reviewed adapter implementations. The fixed role and reviewer-brief files must also come from a trusted package installation, separate from untrusted reviewed content. A capability document, distinct context IDs, or `conservative: true` flag cannot independently prove host permissions, provider memory settings, tokenization accuracy, or absence of network side effects. Prepared payloads may contain sanitized source and must not enter logs or audit records.

`src/adapters/harness/static-review.js` binds a frozen sanitized bundle and policy to a report-only review scope. It exposes no reviewer tools or execution entry point and rechecks scope before preparation and dispatch. `src/adapters/model/lm-studio.js` uses stateless `/v1/chat/completions` requests with no tools, a JSON Schema response format, and `reasoning_effort: "none"`, verified against a local rig the operator configures via `baseUrl`/`modelId` — never a hard-coded address. The exact serialized request is counted through the loaded model's SDK tokenizer before dispatch. It checks loaded local model identity, context length, response model, reported token usage, output finish reason, JSON structure, and tool-call absence. A locally-hosted LM Studio server exposing a loaded quantized model with an 8,192-token context passed SDK preflight and a static-harness synthetic full review in earlier phases (see STATE.md's dated history for that run's specifics); a second rig still lacked SDK tokenization at that time. Further model-behavior evaluation remains required before repository source review. This is one example adapter among several, not a privileged default — see "Writing your own adapter" below.

## Writing your own adapter

The user selects review harnesses before the CLI loads any adapter or performs runtime preflight. With registered [host context](../docs/host-integration.md), no alternatives means the current harness for all three isolated sessions; multiple selections need role assignments. A terminal prompts when no runtime flags are supplied; CI requires explicit flags. `--model` alone does not select a provider. See [harness selection](../docs/harness-selection.md).

Use `--adapter-module FILE --adapter-export NAME [--adapter-config FILE]` for any compatible implementation, or `--routes FILE` for per-role selections. The shipped Claude Code convenience requires `--harness claude-code --model MODEL --context-window TOKENS`. LM Studio uses the same generic loader as user-supplied adapters. [The template](../examples/adapter-template.js) describes the required methods. Additional harness names in examples are not claims of shipped support. Host, model, and account settings belong in user-controlled configuration; never infer or substitute a runtime on failure.

## Application preflight

`runStaticReview` accepts a trusted custom `harnessAdapter` and per-role model adapters. `onPreflight(report)` receives a frozen metadata-only capability report before reviewer invocation. `preflightOnly: true` returns that report without starting reviewers, sandbox commands, or audit persistence. Preparation can query trusted runtime authentication, selected model metadata, and tokenizer services. Missing required controls produce a sanitized refused preflight; normal runs still throw their typed refusal after displaying it. The dispatcher rechecks controls after the callback before sending requests.

A sandbox adapter also implements source-free `preflight({ policy, image })`, returning `ready` with the selected profile/image identity, or `skipped` with a safe reason. Readiness is shown before model calls; execution rechecks the actual runtime and image. An adapter without preflight support cannot run the affected execution mode. Capabilities remain assertions from trusted adapters, with uncertainty shown as limitations rather than inferred guarantees.
