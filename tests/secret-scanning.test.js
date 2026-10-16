import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preflightFiles, scanSecrets } from '../src/core/preflight.js';

const policy = JSON.parse(readFileSync(new URL('../examples/default-policy.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(readFileSync(new URL('../evals/fixtures/secret-scanning/corpus.json', import.meta.url), 'utf8'));
const known = [
  ['aws-access-key', 'AKIAABCDEFGHIJKLMNOP', 'credential'],
  ['github-classic', `ghp_${'A'.repeat(36)}`, 'credential'],
  ['github-fine-grained', `github_pat_${'A'.repeat(24)}`, 'credential'],
  ['gitlab', `glpat-${'A'.repeat(24)}`, 'credential'],
  ['slack', `xoxb-${'A'.repeat(24)}`, 'credential'],
  ['google-api', `AIza${'A'.repeat(35)}`, 'credential'],
  ['stripe', `sk_live_${'A'.repeat(24)}`, 'credential'],
  ['openai-style', `sk-${'A'.repeat(24)}`, 'token'],
  ['private-key', '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----', 'private-key'],
];
const nonSecrets = ['AKIAshort', 'github_pat_short', 'sk-short'];

test('synthetic known-pattern coverage and false-alert count', () => {
  let detected = 0;
  for (const [id, value, kind] of known) {
    const spans = scanSecrets(value);
    assert.equal(spans.length, 1, id);
    assert.equal(spans[0].kind, kind, id);
    const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
      { path: 'src/sample.js', changeType: 'added', content: value },
    ] } }, policy);
    assert.equal(bundle.files[0].content.includes(value), false, id);
    detected++;
  }
  let falseAlerts = 0;
  for (const value of nonSecrets) falseAlerts += scanSecrets(value).length;
  assert.equal(falseAlerts, 0);
  assert.equal(detected, known.length);
  // This is a documented coverage gap, not a claim of complete detection.
  assert.equal(scanSecrets('INTERNAL_SECRET_VALUE_WITH_NO_KNOWN_FORMAT').length, 0);
  console.log(`Synthetic scanner coverage: ${detected}/${known.length} known patterns; ${falseAlerts}/${nonSecrets.length} false alerts; 1 documented unknown-format miss.`);
});

test('trusted scanner adds spans without replacing built-in detection', () => {
  const credential = 'AKIAABCDEFGHIJKLMNOP';
  const marker = 'CUSTOM_SECRET_MARKER';
  const content = `${credential}\n${marker}`;
  const request = { contractVersion: '1.0', input: { kind: 'files', files: [
    { path: 'src/sample.js', changeType: 'added', content },
  ] } };
  const scan = (text) => [{ start: text.indexOf(marker), end: text.indexOf(marker) + marker.length, kind: 'other' }];
  const bundle = preflightFiles(request, policy, { scan });
  assert.equal(bundle.files[0].content.includes(credential), false);
  assert.equal(bundle.files[0].content.includes(marker), false);
  assert.throws(() => preflightFiles(request, policy, { scan: () => [
    { start: 0, end: credential.length, kind: 'credential' },
  ] }), (error) => error.code === 'SCANNER_FAILED');
});

test('contextual scanner corpus records detections, false alerts, and known gaps', () => {
  const counts = { positive: 0, negative: 0, 'known-gap': 0 };
  let detected = 0;
  for (const sample of corpus.cases) {
    assert.equal(Object.hasOwn(counts, sample.group), true, sample.id);
    counts[sample.group]++;
    const spans = scanSecrets(sample.content).sort((a, b) => a.start - b.start);
    assert.equal(spans.length, sample.expected.length, sample.id);
    sample.expected.forEach(({ value, kind }, index) => {
      assert.equal(spans[index].kind, kind, sample.id);
      assert.equal(sample.content.slice(spans[index].start, spans[index].end), value, sample.id);
      detected++;
    });
    if (sample.group === 'positive') {
      const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
        { path: 'src/sample.txt', changeType: 'added', content: sample.content },
      ] } }, policy);
      for (const { value } of sample.expected) {
        assert.equal(bundle.files[0].content.includes(value), false, sample.id);
      }
    }
  }
  assert.ok(counts.positive > 0 && counts.negative > 0 && counts['known-gap'] > 0);
  console.log(`Context corpus: ${detected} detected values in ${counts.positive} positive cases; 0 alerts in ${counts.negative} negative cases; ${counts['known-gap']} documented gap cases.`);
});
