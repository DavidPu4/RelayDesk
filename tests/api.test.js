import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { createService } from '../src/backend/server.js';
import { sign } from '../src/backend/signing.js';

async function fixture(t, options = {}) {
  const service = await createService({ dbPath: ':memory:', port: 0,
    storeOptions: { retryBaseMs: 2, retryCapMs: 8, random: () => .5 },
    workerOptions: { pollMs: 10, timeoutMs: 500 }, ...options });
  t.after(() => service.close());
  return service;
}

async function json(service, path, method = 'GET', body, headers = {}) {
  const response = await fetch(service.url + path, { method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error('HTTP workflow did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('real HTTP failure demo recovers transient errors, exhausts failures, and replays after repair', async t => {
  const s = await fixture(t);
  const start = await json(s, '/api/demo/run', 'POST');
  assert.equal(start.status, 202);
  assert.equal(start.body.eventIds.length, 3);
  const overview = await until(async () => {
    const { body } = await json(s, '/api/overview');
    return body.delivered === 2 && body.deadLetter === 1 && body;
  });
  assert.equal(overview.totalEvents, 3);
  assert.equal(overview.totalDeliveries, 3);
  assert.equal(overview.duplicatesPrevented, 1);
  assert.equal(overview.recovered, 1);
  const deliveries = (await json(s, '/api/deliveries')).body.items;
  const failed = deliveries.find(item => item.status === 'dead_letter');
  assert.equal(failed.attemptCount, 4);
  const failedDetail = (await json(s, '/api/deliveries/' + failed.id)).body;
  assert.equal(failedDetail.attempts.length, 4);
  assert.ok(failedDetail.attempts.every(attempt => attempt.statusCode === 503));
  assert.equal((await json(s, '/api/endpoints/' + failed.endpointId, 'PATCH', { behavior: 'healthy' })).status, 200);
  assert.equal((await json(s, '/api/deliveries/' + failed.id + '/retry', 'POST')).status, 200);
  const repaired = await until(async () => {
    const { body } = await json(s, '/api/deliveries/' + failed.id);
    return body.status === 'delivered' && body;
  });
  assert.equal(repaired.attempts.length, 5);
  assert.equal(repaired.attempts[0].statusCode, 503);
  assert.equal(repaired.attempts.at(-1).statusCode, 200);
  assert.equal(repaired.receipt.duplicateCount, 0);
  const receipts = (await json(s, '/api/receipts')).body.items;
  assert.equal(receipts.length, 3);
  assert.equal((await json(s, '/api/deliveries/' + failed.id + '/retry', 'POST')).status, 409);
});

test('identical concurrent submissions create one event and key/content conflicts return 409', async t => {
  const s = await fixture(t, { startWorker: false });
  const endpoint = s.store.listEndpoints()[0];
  const event = { type: 'order.created', payload: { order: { id: 'demo', quantity: 1 } }, endpointIds: [endpoint.id], idempotencyKey: 'concurrent-http' };
  const results = await Promise.all(Array.from({ length: 12 }, () => json(s, '/api/events', 'POST', event)));
  assert.equal(results.filter(result => result.status === 202).length, 1);
  assert.equal(results.filter(result => result.status === 200).length, 11);
  assert.equal(new Set(results.map(result => result.body.eventId)).size, 1);
  const conflict = await json(s, '/api/events', 'POST', { ...event, payload: { different: true } });
  assert.equal(conflict.status, 409);
  assert.equal(s.store.overview().totalDeliveries, 1);
  assert.equal(s.store.overview().duplicatesPrevented, 11);
});

test('invalid fan-out is atomic and disabled destinations reject new work', async t => {
  const s = await fixture(t, { startWorker: false });
  const endpoint = s.store.listEndpoints()[0];
  const event = { type: 'order.created', payload: {}, endpointIds: [endpoint.id, 'missing'], idempotencyKey: 'atomic-fanout' };
  assert.equal((await json(s, '/api/events', 'POST', event)).status, 404);
  assert.equal(s.store.overview().totalEvents, 0);
  assert.equal(s.store.listDeliveries().length, 0);
  await json(s, '/api/endpoints/' + endpoint.id, 'PATCH', { enabled: false });
  assert.equal((await json(s, '/api/events', 'POST', { ...event, endpointIds: [endpoint.id] })).status, 409);
});

test('receiver verifies exact signed bytes and records one logical receipt for retransmission', async t => {
  const s = await fixture(t, { startWorker: false });
  const endpoint = s.store.listEndpoints().find(item => item.behavior === 'healthy');
  const event = s.store.createEvent({ type: 'test.created', payload: { synthetic: true }, endpointIds: [endpoint.id], idempotencyKey: 'signed-receipt' });
  const raw = '{ "synthetic": true }';
  const secret = s.store.getEndpointSecret(endpoint.id);
  const headers = { 'Content-Type': 'application/json', 'X-RelayDesk-Event': event.eventId, 'X-RelayDesk-Signature': sign(secret, event.eventId, raw) };
  const url = s.url + '/receivers/' + endpoint.id;
  assert.equal((await fetch(url, { method: 'POST', headers, body: raw + ' ' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-RelayDesk-Signature': sign(secret, event.eventId, raw, Math.floor(Date.now() / 1000) - 301) }, body: raw })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers, body: raw })).status, 200);
  assert.equal((await fetch(url, { method: 'POST', headers, body: raw })).status, 200);
  const receipts = s.store.listReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].duplicateCount, 1);
});

test('cross-origin browser mutations and untrusted Host headers are blocked', async t => {
  const s = await fixture(t, { startWorker: false });
  assert.equal((await json(s, '/api/demo/run', 'POST', undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await json(s, '/api/demo/run', 'POST', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(s.store.overview().totalEvents, 0);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(s.url + '/api/health', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
  assert.equal((await json(s, '/api/demo/run', 'POST', undefined, { Origin: s.url })).status, 202);
});

test('malformed, oversized, and unsupported request bodies produce structured errors', async t => {
  const s = await fixture(t, { startWorker: false });
  const malformed = await fetch(s.url + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  const oversized = await fetch(s.url + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'a'.repeat(17 * 1024) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'PAYLOAD_TOO_LARGE');
  const form = await fetch(s.url + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'payload=demo' });
  assert.equal(form.status, 415);
  assert.equal(s.store.overview().totalEvents, 0);
});

test('delivery search and filters are bounded and endpoint responses never expose signing keys', async t => {
  const s = await fixture(t, { startWorker: false });
  const endpoints = await json(s, '/api/endpoints');
  assert.equal(endpoints.body.items.length, 3);
  assert.ok(endpoints.body.items.every(item => !('secret' in item)));
  await json(s, '/api/demo/run', 'POST');
  const filtered = await json(s, '/api/deliveries?status=queued&q=order.created&limit=2');
  assert.equal(filtered.body.items.length, 2);
  assert.ok(filtered.body.items.every(item => item.status === 'queued'));
  assert.equal((await json(s, '/api/deliveries?limit=10000')).status, 400);
  assert.equal((await json(s, '/api/deliveries?status=imaginary')).status, 400);
  assert.equal((await json(s, '/api/deliveries?q=a&q=b')).status, 400);
  assert.equal((await json(s, '/api/deliveries/missing')).status, 404);
});

test('endpoint and event schemas reject wrong types before database writes', async t => {
  const s = await fixture(t, { startWorker: false });
  assert.equal((await json(s, '/api/endpoints', 'POST', { name: 'Demo', behavior: 'unknown' })).status, 400);
  const endpoint = s.store.listEndpoints()[0];
  assert.equal((await json(s, '/api/endpoints/' + endpoint.id, 'PATCH', { enabled: 'false' })).status, 400);
  assert.equal((await json(s, '/api/endpoints/' + endpoint.id, 'PATCH', { secret: 'replacement' })).status, 400);
  const base = { type: 'order.created', payload: {}, endpointIds: [endpoint.id], idempotencyKey: 'valid-key' };
  for (const change of [{ payload: [] }, { type: '' }, { endpointIds: [] }, { idempotencyKey: 'bad key' }, { maxAttempts: 0 }]) {
    assert.equal((await json(s, '/api/events', 'POST', { ...base, ...change })).status, 400);
  }
  assert.equal(s.store.overview().totalEvents, 0);
});
