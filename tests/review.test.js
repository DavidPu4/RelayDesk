import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Store } from '../src/backend/store.js';
import { createWorker } from '../src/backend/worker.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relaydesk-review-'));
  const path = join(directory, 'review.sqlite');
  const stores = [];
  const workers = [];
  t.after(async () => {
    for (const worker of workers) await worker.stop();
    for (const store of stores.toReversed()) store.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('relaydesk-review-'));
    rmSync(target, { recursive: true, force: true });
  });
  return {
    path,
    workers,
    open(options) {
      const store = new Store(path, options);
      stores.push(store);
      return store;
    },
  };
}

function enqueue(store, maxAttempts = 4) {
  const endpoint = store.createEndpoint({ name: 'Review receiver', behavior: 'healthy' });
  const event = store.createEvent({
    type: 'review.created',
    payload: { source: 'independent-test', quantity: 3 },
    endpointIds: [endpoint.id],
    idempotencyKey: 'review-event',
    maxAttempts,
  });
  return event.deliveryIds[0];
}

async function waitUntil(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Condition did not become true before timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('an expired lease owner cannot overwrite the replacement owner', t => {
  const f = fixture(t);
  let now = Date.now();
  const first = f.open({ now: () => now });
  const second = f.open({ now: () => now });
  const deliveryId = enqueue(first);
  const abandoned = first.claimNext({ leaseMs: 50 });
  now += 51;
  const replacement = second.claimNext({ leaseMs: 50 });
  assert.equal(replacement.id, deliveryId);
  assert.notEqual(replacement.leaseToken, abandoned.leaseToken);
  assert.equal(first.completeDelivery(deliveryId, abandoned.leaseToken, {
    ok: true, statusCode: 200, durationMs: 2,
  }), false);
  assert.equal(second.getDelivery(deliveryId).status, 'processing');
  assert.equal(second.getDelivery(deliveryId).attempts[0].outcome, 'lease_expired');
  assert.equal(second.completeDelivery(deliveryId, replacement.leaseToken, {
    ok: true, statusCode: 200, durationMs: 3,
  }), true);
  const final = first.getDelivery(deliveryId);
  assert.equal(final.status, 'delivered');
  assert.equal(final.attemptCount, 2);
  assert.deepEqual(final.attempts.map(a => a.outcome), ['lease_expired', 'delivered']);
});

test('an expired final attempt terminates and manual recovery preserves history', t => {
  const f = fixture(t);
  let now = Date.now();
  const store = f.open({ now: () => now });
  const deliveryId = enqueue(store, 1);
  store.claimNext({ leaseMs: 50 });
  now += 51;
  assert.equal(store.claimNext({ leaseMs: 50 }), null);
  const failed = store.getDelivery(deliveryId);
  assert.equal(failed.status, 'dead_letter');
  assert.equal(failed.attempts.length, 1);
  assert.equal(failed.attempts[0].outcome, 'lease_expired');
  assert.equal(failed.attempts[0].finishedAt, now);
  store.retryDelivery(deliveryId);
  const recovery = store.claimNext();
  assert.equal(recovery.attemptNumber, 2);
  store.completeDelivery(deliveryId, recovery.leaseToken, {
    ok: true, statusCode: 200, durationMs: 1,
  });
  const final = store.getDelivery(deliveryId);
  assert.equal(final.status, 'delivered');
  assert.deepEqual(final.attempts.map(a => a.number), [1, 2]);
  assert.equal(final.attempts[0].outcome, 'lease_expired');
});

test('shutdown aborts transport without recording a false terminal result', { timeout: 8000 }, async t => {
  const f = fixture(t);
  let now = Date.now();
  const store = f.open({ now: () => now });
  const deliveryId = enqueue(store);
  let transportStarted = false;
  let aborted = false;
  const worker = createWorker({
    store,
    baseUrl: 'http://127.0.0.1:39999',
    pollMs: 5,
    timeoutMs: 4000,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      transportStarted = true;
      const abort = () => {
        aborted = true;
        reject(new DOMException('Transport aborted', 'AbortError'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  f.workers.push(worker);
  worker.start();
  await waitUntil(() => transportStarted);
  await worker.stop();
  assert.equal(aborted, true);
  const abandoned = store.getDelivery(deliveryId);
  assert.equal(abandoned.status, 'processing');
  assert.equal(abandoned.attempts[0].outcome, 'in_progress');
  now += 16000;
  const recoveringStore = f.open({ now: () => now });
  const job = recoveringStore.claimNext();
  assert.equal(job.id, deliveryId);
  assert.equal(job.attemptNumber, 2);
  recoveringStore.completeDelivery(deliveryId, job.leaseToken, {
    ok: true, statusCode: 200, durationMs: 1,
  });
  assert.equal(store.getDelivery(deliveryId).status, 'delivered');
});

test('HTTP response streams are bounded before storing an excerpt', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const store = f.open();
  const deliveryId = enqueue(store);
  let chunks = 0;
  let cancelled = false;
  const worker = createWorker({
    store,
    baseUrl: 'http://127.0.0.1:39999',
    pollMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(256).fill(65));
        if (chunks === 100) controller.close();
      },
      cancel() { cancelled = true; },
    }), { status: 200 }),
  });
  f.workers.push(worker);
  worker.start();
  await waitUntil(() => store.getDelivery(deliveryId).status === 'delivered');
  await worker.stop();
  const attempt = store.getDelivery(deliveryId).attempts[0];
  assert.ok(attempt.responseBody.length <= 1024);
  assert.ok(chunks <= 33, `Transport consumed ${chunks * 256} bytes instead of bounding the response`);
  assert.equal(cancelled, true);
});
