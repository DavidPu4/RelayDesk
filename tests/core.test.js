import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, DomainError } from '../src/backend/store.js';
import { sign, verify } from '../src/backend/signing.js';
import { createWorker } from '../src/backend/worker.js';

function fixture(t, options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'relaydesk-core-'));
  let time = 1_700_000_000_000;
  const store = new Store(join(folder, 'test.sqlite'), { now: () => time, random: () => .5, ...options });
  const connections = [store];
  const endpoint = store.createEndpoint({ name: 'Test receiver', behavior: 'healthy' });
  t.after(() => {
    for (const connection of connections) {
      try { connection.close(); } catch { /* A persistence test may already have closed this connection. */ }
    }
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + '\\relaydesk-core-') || resolve(folder).startsWith(resolve(tmpdir()) + '/relaydesk-core-'));
    rmSync(folder, { recursive: true, force: true });
  });
  return { store, endpoint, path: join(folder, 'test.sqlite'), now: () => time,
    connect: () => { const connection = new Store(join(folder, 'test.sqlite'), { now: () => time }); connections.push(connection); return connection; },
    advance: (ms) => { time += ms; },
    event: (overrides = {}) => store.createEvent({ type: 'order.created', payload: { order: 42 }, endpointIds: [endpoint.id],
      idempotencyKey: 'event-1', ...overrides }) };
}

function finish(store, job, statusCode) {
  return store.completeDelivery(job.id, job.leaseToken, { ok: statusCode >= 200 && statusCode < 300, statusCode, durationMs: 12 });
}

test('HMAC signs the exact body, event identity and bounded timestamp', () => {
  const time = 1_700_000_000_000;
  const signature = sign('secret', 'evt_1', '{"value":1}', time / 1000);
  assert.equal(verify('secret', 'evt_1', '{"value":1}', signature, time), true);
  assert.equal(verify('wrong', 'evt_1', '{"value":1}', signature, time), false);
  assert.equal(verify('secret', 'evt_2', '{"value":1}', signature, time), false);
  assert.equal(verify('secret', 'evt_1', '{"value":2}', signature, time), false);
  assert.equal(verify('secret', 'evt_1', '{"value":1}', signature, time + 300_001), false);
  assert.equal(verify('secret', 'evt_1', '{"value":1}', signature, time - 300_001), false);
  for (const malformed of [null, '', 't=abc,v1=0', signature + ',v1=0', signature.replace('v1=', 'v1=zz')]) {
    assert.equal(verify('secret', 'evt_1', '{"value":1}', malformed, time), false);
  }
});

test('idempotency canonicalizes nested object keys and destination ordering', (t) => {
  const f = fixture(t);
  const second = f.store.createEndpoint({ name: 'Second', behavior: 'healthy' });
  const first = f.event({ payload: { b: { z: 1, a: 2 }, a: [3, 4] }, endpointIds: [f.endpoint.id, second.id] });
  const replay = f.event({ payload: { a: [3, 4], b: { a: 2, z: 1 } }, endpointIds: [second.id, f.endpoint.id] });
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);
  assert.deepEqual(replay.deliveryIds, first.deliveryIds);
  assert.equal(f.store.overview().totalEvents, 1);
  assert.equal(f.store.overview().totalDeliveries, 2);
  assert.equal(f.store.overview().duplicatesPrevented, 1);
  assert.throws(() => f.event({ payload: { order: 'changed' } }), (error) => error instanceof DomainError && error.status === 409);
  assert.equal(f.store.overview().duplicatesPrevented, 1);
});

test('unknown destination rolls back all fanout writes', (t) => {
  const f = fixture(t);
  assert.throws(() => f.event({ endpointIds: [f.endpoint.id, 'missing'] }), (error) => error.status === 404);
  assert.equal(f.store.overview().totalEvents, 0);
  assert.equal(f.store.overview().totalDeliveries, 0);
});

test('disabled endpoints reject new events but retain original idempotent replay', (t) => {
  const f = fixture(t);
  const original = f.event();
  f.store.updateEndpoint(f.endpoint.id, { enabled: false });
  assert.equal(f.event().eventId, original.eventId);
  assert.throws(() => f.event({ idempotencyKey: 'new-key' }), (error) => error.code === 'endpoint_disabled');
  assert.ok(f.store.claimNext(), 'queued work is not stranded when an endpoint is disabled later');
  assert.equal('secret' in f.store.listEndpoints()[0], false);
  assert.equal(f.store.getEndpointSecret('unknown'), null);
});

test('payload and public query validation reject unsupported input', (t) => {
  const f = fixture(t);
  for (const payload of [null, [], { invalid: Infinity }, { unsupported: undefined }]) {
    assert.throws(() => f.event({ payload }), (error) => error.status === 400);
  }
  assert.throws(() => f.event({ maxAttempts: 0 }), (error) => error.status === 400);
  assert.throws(() => f.event({ payload: { huge: 'a'.repeat(17_000) } }), (error) => error.status === 413);
  assert.throws(() => f.store.listDeliveries({ status: "' OR 1=1" }), (error) => error.status === 400);
  assert.throws(() => f.store.listDeliveries({ limit: -1 }), (error) => error.status === 400);
  assert.equal(f.store.overview().totalEvents, 0);
});

test('two database connections cannot simultaneously claim one live lease', (t) => {
  const f = fixture(t);
  f.event();
  const other = f.connect();
  const claim = f.store.claimNext();
  assert.ok(claim);
  assert.equal(other.claimNext(), null);
  assert.equal(f.store.getDelivery(claim.id).attemptCount, 1);
  assert.equal(f.store.getDelivery(claim.id).attempts.length, 1);
  assert.equal(finish(other, claim, 204), true);
  assert.equal(f.store.getDelivery(claim.id).status, 'delivered');
});

test('exponential backoff is due-aware, capped, and stops at the attempt budget', (t) => {
  const f = fixture(t, { retryCapMs: 2500 });
  const { deliveryIds: [deliveryId] } = f.event();
  for (const delay of [1000, 2000, 2500]) {
    const claim = f.store.claimNext();
    assert.ok(claim);
    assert.equal(finish(f.store, claim, 503), true);
    const current = f.store.getDelivery(deliveryId);
    assert.equal(current.status, 'retrying');
    assert.equal(current.nextAttemptAt, f.now() + delay);
    assert.equal(f.store.claimNext(), null);
    f.advance(delay);
  }
  finish(f.store, f.store.claimNext(), 503);
  const exhausted = f.store.getDelivery(deliveryId);
  assert.equal(exhausted.status, 'dead_letter');
  assert.equal(exhausted.attemptCount, 4);
  assert.equal(exhausted.nextAttemptAt, null);
  assert.equal(f.store.claimNext(), null);
  assert.deepEqual(exhausted.attempts.map((a) => a.number), [1, 2, 3, 4]);
});

test('jitter remains within configured range', (t) => {
  const f = fixture(t, { random: () => 0 });
  const event = f.event();
  finish(f.store, f.store.claimNext(), 429);
  assert.equal(f.store.getDelivery(event.deliveryIds[0]).nextAttemptAt, f.now() + 800);
});

test('permanent HTTP errors are dead-lettered without retrying', (t) => {
  const f = fixture(t);
  const event = f.event();
  finish(f.store, f.store.claimNext(), 400);
  const delivery = f.store.getDelivery(event.deliveryIds[0]);
  assert.equal(delivery.status, 'dead_letter');
  assert.equal(delivery.attemptCount, 1);
});

test('dead-letter replay repairs delivery without losing attempt history', (t) => {
  const f = fixture(t);
  const { deliveryIds: [deliveryId] } = f.event();
  finish(f.store, f.store.claimNext(), 400);
  const replay = f.store.retryDelivery(deliveryId);
  assert.equal(replay.status, 'queued');
  assert.equal(replay.attemptCount, 1);
  assert.equal(replay.maxAttempts, 5);
  finish(f.store, f.store.claimNext(), 200);
  assert.equal(f.store.getDelivery(deliveryId).status, 'delivered');
  assert.deepEqual(f.store.getDelivery(deliveryId).attempts.map((a) => a.number), [1, 2]);
  assert.equal(f.store.overview().recovered, 1);
  assert.throws(() => f.store.retryDelivery(deliveryId), (error) => error.status === 409);
});

test('an expired worker is fenced after lease recovery', (t) => {
  const f = fixture(t);
  const { deliveryIds: [deliveryId] } = f.event();
  const stale = f.store.claimNext({ leaseMs: 100 });
  f.advance(101);
  const replacement = f.store.claimNext();
  assert.equal(replacement.id, stale.id);
  assert.notEqual(replacement.leaseToken, stale.leaseToken);
  assert.equal(finish(f.store, stale, 200), false);
  assert.equal(finish(f.store, replacement, 200), true);
  const detail = f.store.getDelivery(deliveryId);
  assert.deepEqual(detail.attempts.map((a) => a.outcome), ['lease_expired', 'delivered']);
});

test('crash recovery exhausts the final lease instead of retrying forever', (t) => {
  const f = fixture(t);
  const { deliveryIds: [deliveryId] } = f.event({ maxAttempts: 1 });
  f.store.claimNext({ leaseMs: 10 });
  f.advance(11);
  assert.equal(f.store.claimNext(), null);
  assert.equal(f.store.getDelivery(deliveryId).status, 'dead_letter');
  assert.equal(f.store.getDelivery(deliveryId).attempts[0].outcome, 'lease_expired');
});

test('queued work and attempt history survive a database reopen', (t) => {
  const f = fixture(t);
  const { deliveryIds: [deliveryId] } = f.event();
  finish(f.store, f.store.claimNext(), 503);
  f.store.close();
  f.advance(1001);
  const reopened = f.connect();
  const claim = reopened.claimNext();
  assert.equal(claim.id, deliveryId);
  assert.equal(claim.attemptNumber, 2);
  finish(reopened, claim, 200);
  assert.equal(reopened.getDelivery(deliveryId).attempts.length, 2);
});

test('receiver accepts an event only once and records duplicate deliveries', (t) => {
  const f = fixture(t);
  const event = f.event();
  assert.equal(f.store.receiveDemo(f.endpoint.id, event.eventId).duplicate, false);
  assert.equal(f.store.receiveDemo(f.endpoint.id, event.eventId).duplicate, true);
  assert.equal(f.store.listReceipts().length, 1);
  assert.equal(f.store.listReceipts()[0].duplicateCount, 1);
  assert.throws(() => f.store.receiveDemo(f.endpoint.id, 'unaddressed'), (error) => error.status === 404);
});

test('flaky receiver fails exactly twice before accepting', (t) => {
  const f = fixture(t);
  f.store.updateEndpoint(f.endpoint.id, { behavior: 'flaky' });
  const event = f.event();
  assert.deepEqual([1, 2, 3].map(() => f.store.receiveDemo(f.endpoint.id, event.eventId).statusCode), [503, 503, 200]);
  assert.equal(f.store.listReceipts().length, 1);
});

test('search escapes wildcard characters and overview uses persisted facts', (t) => {
  const f = fixture(t);
  f.event();
  finish(f.store, f.store.claimNext(), 200);
  assert.equal(f.store.listDeliveries({ query: 'order.created' }).length, 1);
  assert.equal(f.store.listDeliveries({ query: '%' }).length, 0);
  assert.equal(f.store.overview().successRate, 100);
  assert.equal(f.store.overview().avgLatencyMs, 12);
  assert.equal(f.store.overview().activity.reduce((sum, item) => sum + item.delivered, 0), 1);
});

test('worker signs actual payload requests and records successful responses', async (t) => {
  const f = fixture(t);
  const { deliveryIds: [deliveryId] } = f.event();
  const worker = createWorker({ store: f.store, baseUrl: 'http://127.0.0.1:9999', fetchImpl: async (url, options) => {
    assert.equal(url.pathname, `/receivers/${f.endpoint.id}`);
    assert.equal(options.redirect, 'error');
    assert.equal(verify(f.store.getEndpointSecret(f.endpoint.id), options.headers['X-RelayDesk-Event'], options.body,
      options.headers['X-RelayDesk-Signature']), true);
    return new Response('{"accepted":true}', { status: 200 });
  } });
  await worker.tick();
  assert.equal(f.store.getDelivery(deliveryId).status, 'delivered');
  assert.equal(f.store.getDelivery(deliveryId).attempts[0].responseBody, '{"accepted":true}');
  await worker.stop();
});

test('worker enforces request timeout and persists a retryable failure', async (t) => {
  const f = fixture(t);
  const { deliveryIds: [deliveryId] } = f.event();
  const worker = createWorker({ store: f.store, baseUrl: 'http://127.0.0.1:9999', timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  await worker.tick();
  const delivery = f.store.getDelivery(deliveryId);
  assert.equal(delivery.status, 'retrying');
  assert.match(delivery.lastError, /timed out/);
  await worker.stop();
});

test('worker concurrency bounds the number of simultaneous requests', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) f.event({ idempotencyKey: `parallel-${index}` });
  let active = 0;
  let peak = 0;
  const worker = createWorker({ store: f.store, baseUrl: 'http://127.0.0.1:9999', concurrency: 2,
    fetchImpl: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response('{}', { status: 200 });
    } });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(peak, 2);
  assert.equal(f.store.overview().delivered, 2);
  await worker.tick();
  await worker.tick();
  assert.equal(f.store.overview().delivered, 5);
  await worker.stop();
});
