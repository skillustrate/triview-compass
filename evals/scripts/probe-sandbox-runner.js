#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preflightFiles } from '../../src/core/preflight.js';
import { runPodmanSandbox } from '../../src/adapters/sandbox/podman-runner.js';

const image = process.argv[2];
if (!image) throw new Error('Pass an already-local, digest-pinned Python image reference.');
const policy = JSON.parse(readFileSync(new URL('../../examples/default-policy.json', import.meta.url), 'utf8'));
policy.sandbox = { executionRequested: true, backend: 'podman', network: 'disabled' };
const probe = String.raw`import json, os
def read(path):
    try:
        with open(path) as file:
            return file.read().strip()
    except OSError:
        return None
source_write_blocked = False
try:
    with open('/src/src/check.py', 'a') as file:
        file.write('changed')
except OSError:
    source_write_blocked = True
scratch_writable = False
try:
    with open('/scratch/probe', 'w') as file:
        file.write('ok')
    scratch_writable = True
except OSError:
    pass
print(json.dumps({'uid': os.geteuid(), 'source_write_blocked': source_write_blocked,
    'scratch_writable': scratch_writable, 'network_interfaces': os.listdir('/sys/class/net'),
    'memory_max': read('/sys/fs/cgroup/memory.max'),
    'pids_max': read('/sys/fs/cgroup/pids.max'),
    'cpu_max': read('/sys/fs/cgroup/cpu.max')}))`;
const bundle = preflightFiles({ contractVersion: '1.0', input: { kind: 'files', files: [
  { path: 'src/check.py', changeType: 'added', content: probe },
] } }, policy);
const result = runPodmanSandbox({ policy, bundle, image,
  command: ['/usr/local/bin/python', '/src/src/check.py'] });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== 'completed') process.exitCode = 1;
else {
  const observed = JSON.parse(result.stdout);
  assert.ok(observed.uid > 0);
  assert.equal(observed.source_write_blocked, true);
  assert.equal(observed.scratch_writable, true);
  assert.deepEqual(observed.network_interfaces, ['lo']);
  assert.equal(Number(observed.memory_max), 512 * 1024 * 1024);
  assert.equal(Number(observed.pids_max), 64);
  assert.equal(observed.cpu_max, '100000 100000');
}
