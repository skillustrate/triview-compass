// Starting boilerplate for a model adapter: plug in Codex, Antigravity, your
// own "pi agent," a second LM Studio rig, or anything else that can review
// code and return structured JSON. The CLI never hard-codes which providers
// exist — see adapters/README.md for the full contract this must satisfy,
// and src/adapters/model/{claude-code,lm-studio}.js for two real, working
// examples (used by this project itself, not privileged by the CLI over
// whatever you write here).
//
// Usage once filled in:
//   node src/cli/review.js --request ... --policy ... \
//     --adapter-module path/to/your-copy-of-this-file.js \
//     --adapter-export createMyAdapter \
//     --adapter-config path/to/your-config.json
//
// --adapter-config's parsed JSON (hosts, ports, model IDs, account aliases —
// never commit real ones) is the ONLY place connection details belong. This
// template and the CLI itself contain none.

export function createMyAdapter(config) {
  // `config` is whatever you put in --adapter-config, e.g.:
  //   { "baseUrl": "http://localhost:PORT/v1", "modelId": "your-model-id" }
  const { baseUrl, modelId } = config;
  if (typeof baseUrl !== 'string' || typeof modelId !== 'string') {
    throw new Error('This adapter requires config.baseUrl and config.modelId.');
  }

  // Fill in with your provider's actual capabilities. dataHandling is
  // 'local' or 'hosted'; controls must be 'enforced' for anything the core
  // requires (see model-preflight.js's MODEL_CONTROLS) or the review refuses
  // before any call is made, rather than silently proceeding without it.
  function capabilities() {
    return {
      contractVersion: '1.0',
      adapterId: 'my-adapter-v1',
      adapterType: 'model',
      adapterVersion: '1.0',
      providerId: 'my-provider',       // must match policy.dataPolicy.selectedProvider
      modelId,
      dataHandling: 'local',
      contextWindowTokens: 32768,       // a real, verified value, not a guess
      maxOutputTokens: 4096,
      limitations: [
        // State real, honest gaps here (e.g. "exact served model identity is
        // unverified") rather than omitting them.
      ],
      controls: {
        freshContextPerReviewer: 'enforced',
        crossSessionMemoryDisabled: 'enforced',
        structuredOutput: 'enforced',
        usageReporting: 'unsupported',
      },
    };
  }

  return Object.freeze({
    // Called before and after prompt preparation. Return a fresh capability
    // document reflecting what's actually configured right now — not a
    // cached assumption — so the core can refuse before any model call if
    // something changed.
    getCapabilities: () => capabilities(),
    verifyRuntime: () => capabilities(),

    // Build the exact request payload for one reviewer role. Must be pure
    // (no I/O) — the core hashes and reuses this string later.
    prepareRequest: ({ role, prompt, modelId: requestedModel, maxOutputTokens }) => {
      if (requestedModel !== modelId) throw new Error('Model mismatch.');
      return JSON.stringify({ role, prompt, modelId, maxOutputTokens });
    },

    // Count (or conservatively bound) input tokens for the exact payload
    // prepareRequest produced. Return { upperBound, conservative: true }.
    countInputTokens: ({ payload }) => ({
      upperBound: Buffer.byteLength(payload, 'utf8'),
      conservative: true,
    }),

    // Actually call your provider. Must start a fresh, memory-free, tool-free
    // session per call and return a reviewer-result shape. This is where
    // baseUrl/modelId from config actually get used — fill in the real call.
    invokeReview: async ({ role, invocationId, payload }) => {
      throw new Error(`TODO: implement the real call to ${baseUrl} for role ${role}/${invocationId}.`);
      // A real implementation returns something like:
      // return { contractVersion: '1.0', reviewId, snapshotSha256, invocationId,
      //   contextId: 'a-real-distinct-session-id', reviewer: role,
      //   adapter: { adapterId: 'my-adapter-v1', providerId: 'my-provider', modelId },
      //   promptVersion, skills, status: 'completed', findings: [...], verdict: 'recommend-approval' };
    },
  });
}
