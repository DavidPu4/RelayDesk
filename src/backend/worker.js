import { performance } from 'node:perf_hooks';
import { sign } from './signing.js';

async function readExcerpt(response, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let excerpt = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (excerpt.length < 1024) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) {
        excerpt += decoder.decode();
        break;
      }
      excerpt += decoder.decode(value, { stream: true });
    }
    if (excerpt.length >= 1024) cancel();
    return excerpt.slice(0, 1024);
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* A pending cancellation owns the reader. */ }
  }
}

export function createWorker({ store, baseUrl, concurrency = 3, pollMs = 150, timeoutMs = 1200, fetchImpl = fetch }) {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new TypeError('Invalid receiver base URL.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new TypeError('Worker concurrency must be between 1 and 20.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('Worker intervals must be positive.');
  const active = new Map();
  const controllers = new Set();
  let running = false;
  let stopping = false;
  let interval;
  let lastError = null;

  async function execute(job) {
    const controller = new AbortController();
    controllers.add(controller);
    const started = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Receiver request timed out.'));
    }, timeoutMs);
    try {
      const url = new URL(`/receivers/${encodeURIComponent(job.endpointId)}`, origin);
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-RelayDesk-Event': job.eventId,
          'X-RelayDesk-Delivery': job.id,
          'X-RelayDesk-Signature': sign(job.secret, job.eventId, job.payloadJson),
        },
        body: job.payloadJson,
      });
      const responseBody = await readExcerpt(response, controller.signal);
      if (!stopping) store.completeDelivery(job.id, job.leaseToken, {
        ok: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        responseBody,
        durationMs: performance.now() - started,
      });
    } catch (error) {
      if (!stopping) store.completeDelivery(job.id, job.leaseToken, {
        ok: false, statusCode: null,
        error: timedOut ? `Receiver request timed out after ${timeoutMs} ms.` : 'Could not complete the receiver HTTP request.',
        durationMs: performance.now() - started,
      });
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function tick() {
    if (stopping) return;
    const batch = [];
    while (active.size < concurrency) {
      const job = store.claimNext({ leaseMs: Math.max(15000, Math.ceil(timeoutMs * 2)) });
      if (!job) break;
      const task = execute(job).finally(() => { active.delete(job.leaseToken); });
      active.set(job.leaseToken, task);
      batch.push(task);
    }
    await Promise.all(batch);
  }

  return {
    start() {
      if (running) return;
      if (active.size) throw new Error('Wait for the previous worker stop before restarting.');
      stopping = false;
      running = true;
      const run = () => { void tick().catch((error) => { lastError = error; }); };
      interval = setInterval(run, pollMs);
      interval.unref?.();
      run();
    },
    async stop() {
      stopping = true;
      running = false;
      clearInterval(interval);
      for (const controller of controllers) controller.abort(new Error('Worker stopping.'));
      await Promise.allSettled([...active.values()]);
    },
    tick,
    get running() { return running; },
    get lastError() { return lastError; },
  };
}
