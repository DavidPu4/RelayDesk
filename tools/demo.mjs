import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.RELAYDESK_URL || 'http://127.0.0.1:4328';
const origin = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password) {
  throw new Error('The demo must target a local RelayDesk workspace.');
}
async function api(path, options) {
  const response = await fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

try {
  await api('/api/health');
  const before = await api('/api/overview');
  const run = await api('/api/demo/run', { method: 'POST' });
  console.log('Three synthetic events queued. Waiting for real receiver outcomes...');
  const deadline = Date.now() + 20000;
  let rows;
  while (true) {
    const { items } = await api('/api/deliveries');
    rows = items.filter(item => run.eventIds.includes(item.eventId));
    if (rows.length === 3 && rows.every(item => ['delivered', 'dead_letter'].includes(item.status))) break;
    if (Date.now() > deadline) throw new Error('The demo did not finish in 20 seconds. Inspect the dashboard and worker logs.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const after = await api('/api/overview');
  const delivered = rows.filter(item => item.status === 'delivered');
  const dead = rows.filter(item => item.status === 'dead_letter');
  if (delivered.length !== 2 || dead.length !== 1 || after.duplicatesPrevented !== before.duplicatesPrevented + 1) {
    throw new Error('Unexpected demo outcomes. See the dashboard for actual results.');
  }
  const details = await Promise.all(rows.map(row => api('/api/deliveries/' + row.id)));
  const report = {
    checkedAt: new Date().toISOString(),
    syntheticEvents: true,
    delivered: delivered.length,
    deadLetter: dead.length,
    duplicatePrevented: true,
    deliveries: details.map(item => ({ id: item.id, eventId: item.eventId, status: item.status,
      attempts: item.attempts.map(attempt => ({ number: attempt.number, statusCode: attempt.statusCode, outcome: attempt.outcome })),
      receiptAccepted: item.receipt !== null })),
  };
  const resultDir = fileURLToPath(new URL('../local-results/', import.meta.url));
  await mkdir(resultDir, { recursive: true });
  await writeFile(new URL('../local-results/demo-check.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log('Verified: 2 delivered, 1 dead letter, 1 duplicate prevented.');
  console.log('The flaky receiver recovered on attempt 3; the failing receiver exhausted its budget.');
  console.log('Evidence saved in local-results/demo-check.json. Open the dashboard to repair and replay.');
} catch (error) {
  console.error('Demo check:', error.message);
  console.error('Start RelayDesk with npm start, then rerun npm run demo.');
  process.exitCode = 1;
}
