import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PreflightError } from './errors.js';

const schemas = [
  'common.schema.json',
  'review-request.schema.json',
  'review-policy.schema.json',
  'policy-overrides.schema.json',
  'adapter-capabilities.schema.json',
  'review-bundle.schema.json',
  'reviewer-result.schema.json',
  'preflight-report.schema.json',
  'consolidated-report.schema.json',
  'audit-record.schema.json',
  'host-context.schema.json',
];
const ajv = new Ajv2020({ allErrors: false, strict: false, coerceTypes: false,
  removeAdditional: false, useDefaults: false });
addFormats(ajv);
for (const filename of schemas) {
  const schema = JSON.parse(readFileSync(new URL(`../../contracts/schemas/${filename}`, import.meta.url), 'utf8'));
  ajv.addSchema({ ...schema, $id: `https://triview-compass.local/contracts/${filename}` });
}

const validators = {
  request: ajv.getSchema('https://triview-compass.local/contracts/review-request.schema.json'),
  policy: ajv.getSchema('https://triview-compass.local/contracts/review-policy.schema.json'),
  policyOverrides: ajv.getSchema('https://triview-compass.local/contracts/policy-overrides.schema.json'),
  capabilities: ajv.getSchema('https://triview-compass.local/contracts/adapter-capabilities.schema.json'),
  bundle: ajv.getSchema('https://triview-compass.local/contracts/review-bundle.schema.json'),
  result: ajv.getSchema('https://triview-compass.local/contracts/reviewer-result.schema.json'),
  report: ajv.getSchema('https://triview-compass.local/contracts/consolidated-report.schema.json'),
  sandbox: ajv.compile({ $ref: 'https://triview-compass.local/contracts/consolidated-report.schema.json#/properties/sandbox' }),
  preflight: ajv.getSchema('https://triview-compass.local/contracts/preflight-report.schema.json'),
  audit: ajv.getSchema('https://triview-compass.local/contracts/audit-record.schema.json'),
  hostContext: ajv.getSchema('https://triview-compass.local/contracts/host-context.schema.json'),
};

function assertContract(kind, value, code) {
  if (!validators[kind](value)) {
    // Ajv errors may contain user input. Do not put them in exceptions or logs.
    throw new PreflightError(code, `The ${kind} does not satisfy its v1 contract.`);
  }
}

export function assertReviewRequest(request) {
  assertContract('request', request, 'INVALID_INPUT');
}

export function assertReviewPolicy(policy) {
  assertContract('policy', policy, 'INVALID_POLICY');
  if (Object.values(policy.budgets).some((value) => !Number.isSafeInteger(value))) {
    throw new PreflightError('INVALID_POLICY', 'Policy budgets must be safe integers.');
  }
}

export function assertPolicyOverrides(overrides) {
  assertContract('policyOverrides', overrides, 'INVALID_POLICY_OVERRIDES');
  if (overrides.budgets !== undefined
    && Object.values(overrides.budgets).some((value) => !Number.isSafeInteger(value))) {
    throw new PreflightError('INVALID_POLICY_OVERRIDES', 'Policy budget overrides must be safe integers.');
  }
}

export function assertAdapterCapabilities(capabilities) {
  assertContract('capabilities', capabilities, 'INVALID_CAPABILITIES');
}

export function assertReviewBundle(bundle) {
  assertContract('bundle', bundle, 'INVALID_BUNDLE');
}

export function assertReviewerResult(result) {
  assertContract('result', result, 'INVALID_RESULT');
}

export function assertConsolidatedReport(report) {
  assertContract('report', report, 'INVALID_REPORT');
}

export function assertSandboxResult(result) {
  assertContract('sandbox', result, 'INVALID_SANDBOX_RESULT');
}

export function assertPreflightReport(report) {
  assertContract('preflight', report, 'INVALID_PREFLIGHT_REPORT');
}

export function assertAuditRecord(record) {
  assertContract('audit', record, 'INVALID_AUDIT');
}

export function assertHostContext(context) {
  assertContract('hostContext', context, 'INVALID_HOST_CONTEXT');
}
