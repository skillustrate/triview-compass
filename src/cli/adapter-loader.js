import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClaudeCodeModelAdapter } from '../adapters/model/claude-code.js';

export class CliConfigurationError extends Error {}

export async function createCliModelAdapters(policy, routeConfig, cwd, { spawnImpl, authCheck } = {}) {
  if (!routeConfig || typeof routeConfig !== 'object' || Array.isArray(routeConfig)
    || !policy.dataPolicy.roleRoutes
    || Object.keys(routeConfig).length !== policy.reviewers.length
    || policy.reviewers.some((role) => !Object.hasOwn(routeConfig, role))) {
    throw new CliConfigurationError('The route configuration must cover every selected reviewer.');
  }
  const accounts = new Map();
  const entries = await Promise.all(policy.reviewers.map(async (role) => {
    const route = routeConfig[role];
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new CliConfigurationError('A reviewer route has unsupported configuration.');
    }
    if (route.kind === 'claude-code') {
      if (Object.keys(route).some((key) => !['kind', 'adapterId', 'modelId',
        'contextWindowTokens', 'configDir'].includes(key))) {
        throw new CliConfigurationError('A reviewer route has unsupported configuration.');
      }
      const previous = accounts.get(route.adapterId);
      if (previous !== undefined && previous !== (route.configDir ?? 'default')) {
        throw new CliConfigurationError('One adapter ID cannot refer to two account profiles.');
      }
      accounts.set(route.adapterId, route.configDir ?? 'default');
      return [role, createClaudeCodeModelAdapter({ adapterId: route.adapterId,
        modelId: route.modelId, contextWindowTokens: route.contextWindowTokens,
        configDir: route.configDir, cwd, spawnImpl, authCheck })];
    }
    // Any other provider/harness: no CLI-side list of names, same generic
    // loader as the single-runtime --adapter-module path, just addressed
    // per role from inside the route file instead of from CLI flags.
    if (route.kind === 'adapter-module') {
      if (Object.keys(route).some((key) => !['kind', 'module', 'export', 'config'].includes(key))) {
        throw new CliConfigurationError('A reviewer route has unsupported configuration.');
      }
      return [role, await instantiateAdapterModule(route.module, route.export, route.config ?? {})];
    }
    throw new CliConfigurationError('A reviewer route has unsupported configuration.');
  }));
  return Object.fromEntries(entries);
}

const SAFE_EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

// Loads any user-supplied model adapter by path, with no CLI-side knowledge of
// provider/harness names. The caller owns and trusts this file the same way
// they already trust any other local script they choose to run; this is not
// a boundary against untrusted (e.g. reviewed-repository) content.
export async function instantiateAdapterModule(modulePath, exportName, config) {
  if (typeof modulePath !== 'string' || !modulePath) {
    throw new CliConfigurationError('An adapter module path is required.');
  }
  if (typeof exportName !== 'string' || !SAFE_EXPORT_NAME.test(exportName)) {
    throw new CliConfigurationError('An adapter export name must be a plain identifier.');
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new CliConfigurationError('An adapter config must contain a JSON object.');
  }
  const url = pathToFileURL(isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath));
  let module;
  try { module = await import(url.href); } catch { throw new CliConfigurationError('An adapter module could not be loaded.'); }
  const factory = module[exportName];
  if (typeof factory !== 'function') {
    throw new CliConfigurationError('An adapter export must name an exported function on the module.');
  }
  const adapter = factory(config);
  if (!adapter || typeof adapter.getCapabilities !== 'function' || typeof adapter.verifyRuntime !== 'function'
    || typeof adapter.prepareRequest !== 'function' || typeof adapter.countInputTokens !== 'function'
    || typeof adapter.invokeReview !== 'function') {
    throw new CliConfigurationError('The loaded adapter does not implement the required model-adapter contract.');
  }
  return adapter;
}
