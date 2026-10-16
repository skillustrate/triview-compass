import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = new URL('./', import.meta.url);
const files = [
  { path: 'src/pricing.js', content: `// New API: percent is a whole percentage, e.g. 20 means 20% off.
// applyDiscount(100, 20) must return 80.
export function applyDiscount(price, percent) {
  return price - price * percent;
}
` },
  { path: 'src/backup.js', content: `import { exec } from 'node:child_process';

// Called by an HTTP handler with a user-supplied directory name.
export function backupDirectory(directory) {
  return new Promise((resolve, reject) => {
    exec('tar -czf /tmp/backup.tar.gz ' + directory, (error) => {
      if (error) reject(error);
      else resolve('/tmp/backup.tar.gz');
    });
  });
}
` },
  { path: 'src/order-summary.js', content: `// New endpoint helper: return each customer's total order value.
// Customer IDs are unique. Production batches have 100,000 customers
// and 1,000,000 orders; this runs on every request without caching.
export function summarizeOrders(customers, orders) {
  return customers.map(customer => {
    let total = 0;
    for (const order of orders) {
      if (order.customerId === customer.id) total += order.amount;
    }
    return { customerId: customer.id, total };
  });
}
` },
];
const request = { contractVersion: '1.0', input: { kind: 'files', files: files.map(file => ({ ...file, changeType: 'added' })) } };
const policy = JSON.parse(await readFile(new URL('../../../examples/claude-code-policy.json', import.meta.url)));
const cwd = await mkdtemp(join(tmpdir(), 'triview-codex-live-'));
await writeFile(new URL('request.json', directory), JSON.stringify(request, null, 2) + '\n');
await writeFile(new URL('policy.json', directory), JSON.stringify(policy, null, 2) + '\n');
await writeFile('/tmp/triview-codex-live-adapter.json', JSON.stringify({
  command: join(homedir(), '.local/share/claude/versions/2.1.300'),
  modelId: 'sonnet', contextWindowTokens: 200000, cwd,
}));
console.log('Created synthetic request, policy, and temporary adapter configuration.');
