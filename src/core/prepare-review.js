import { prepareAdapterHandshake } from './adapter-handshake.js';
import { buildReviewerPrompts } from './prompt-builder.js';

// The supported pre-dispatch entry point. It constructs prompts from this exact
// frozen bundle, then counts the exact serialized adapter requests. It does not
// invoke a model or expose the local file-ID resolver to the model adapter.
export async function prepareReviewInputs(policy, bundle, { harnessAdapter, modelAdapter, modelAdapters } = {}) {
  const built = buildReviewerPrompts(bundle, policy);
  const handshake = await prepareAdapterHandshake(policy, bundle, {
    harnessAdapter, modelAdapter, modelAdapters, prompts: built.prompts,
  });
  return Object.freeze({
    ...handshake,
    promptVersions: built.promptVersions,
    resolveFileId: built.resolveFileId,
  });
}
