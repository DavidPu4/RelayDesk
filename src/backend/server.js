import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, DomainError } from './store.js';
import { verify } from './signing.js';
import { createWorker } from './worker.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BEHAVIORS = new Set(['healthy', 'flaky', 'failing']);
const STATUSES = new Set(['queued', 'processing', 'retrying', 'delivered', 'dead_letter']);
const error = (message, code = 'INVALID_REQUEST', status = 400) => new DomainError(status, code, message);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateEvent(body) {
  if (!object(body)) throw error('Send a JSON object describing an event.');
  if (typeof body.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(body.type)) {
    throw error('Event type must be 1-80 letters, numbers, dots, colons, hyphens, or underscores.');
  }
  if (!object(body.payload)) throw error('Payload must be a JSON object.');
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.idempotencyKey)) {
    throw error('Use a unique idempotency key of 1-128 letters, numbers, dots, colons, hyphens, or underscores.');
  }
  if (!Array.isArray(body.endpointIds) || body.endpointIds.length < 1 || body.endpointIds.length > 10 ||
      body.endpointIds.some(id => typeof id !== 'string' || id.length > 100 || !id)) {
    throw error('Select between 1 and 10 valid destination IDs.');
  }
  const maxAttempts = body.maxAttempts ?? 4;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw error('Maximum attempts must be between 1 and 8.');
  return { ...body, maxAttempts };
}

function validateEndpoint(body, patch = false) {
  if (!object(body)) throw error('Send a JSON object describing a destination.');
  const fields = Object.keys(body);
  const allowed = patch ? new Set(['behavior', 'enabled']) : new Set(['name', 'behavior']);
  if (!fields.length || fields.some(key => !allowed.has(key))) throw error('The destination contains unsupported fields.');
  if (!patch && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80)) {
    throw error('Destination name must be between 1 and 80 characters.');
  }
  if ((!patch || 'behavior' in body) && !BEHAVIORS.has(body.behavior)) throw error('Choose healthy, flaky, or failing receiver behavior.');
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw error('Enabled must be true or false.');
  return patch ? body : { name: body.name.trim(), behavior: body.behavior };
}

export function createApp({ store }) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.allowedHosts = new Set();
  app.locals.allowedOrigins = new Set();
  app.locals.worker = null;

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!app.locals.allowedHosts.has(req.headers.host)) return next(error('This workspace accepts only its configured local host.', 'UNTRUSTED_HOST', 403));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if ((req.headers.origin && !app.locals.allowedOrigins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
        return next(error('Open this workspace directly to make changes.', 'UNTRUSTED_ORIGIN', 403));
      }
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true, verify(req, _res, buffer) { req.rawBody = buffer.toString('utf8'); } }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const jsonOnly = (req, _res, next) => req.is('application/json') ? next() : next(error('Send application/json content.', 'UNSUPPORTED_MEDIA_TYPE', 415));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0', workerRunning: Boolean(app.locals.worker?.running) }));
  app.get('/api/overview', (_req, res) => res.json(store.overview()));
  app.get('/api/endpoints', (_req, res) => res.json({ items: store.listEndpoints() }));
  app.post('/api/endpoints', jsonOnly, (req, res) => res.status(201).json(store.createEndpoint(validateEndpoint(req.body))));
  app.patch('/api/endpoints/:id', jsonOnly, (req, res) => res.json(store.updateEndpoint(req.params.id, validateEndpoint(req.body, true))));
  app.post('/api/events', jsonOnly, (req, res) => {
    const result = store.createEvent(validateEvent(req.body));
    res.status(result.replayed ? 200 : 202).json(result);
  });
  app.get('/api/deliveries', (req, res) => {
    const status = req.query.status === 'all' ? undefined : req.query.status;
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) throw error('Unknown delivery status.');
    if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 128)) throw error('Search text must be at most 128 characters.');
    const limitText = req.query.limit ?? '100';
    if (typeof limitText !== 'string' || !/^\d+$/.test(limitText) || +limitText < 1 || +limitText > 200) throw error('Limit must be between 1 and 200.');
    res.json({ items: store.listDeliveries({ status, query: req.query.q, limit: +limitText }) });
  });
  app.get('/api/deliveries/:id', (req, res) => {
    const item = store.getDelivery(req.params.id);
    if (!item) throw error('Delivery was not found.', 'NOT_FOUND', 404);
    res.json(item);
  });
  app.post('/api/deliveries/:id/retry', (req, res) => res.json(store.retryDelivery(req.params.id)));
  app.get('/api/receipts', (_req, res) => res.json({ items: store.listReceipts() }));
  app.post('/api/demo/run', (_req, res) => {
    const runId = randomUUID();
    const eventIds = [];
    for (const [index, behavior] of ['healthy', 'flaky', 'failing'].entries()) {
      let endpoint = store.listEndpoints().find(item => item.behavior === behavior && item.enabled);
      if (!endpoint) endpoint = store.createEndpoint({ name: `Demo ${behavior} receiver`, behavior });
      const event = { type: 'order.created', payload: { demo: true, orderId: `DEMO-${runId.slice(0, 6)}-${index + 1}`, item: ['Canvas tote', 'Travel mug', 'Studio notebook'][index], quantity: 1 }, endpointIds: [endpoint.id], idempotencyKey: `demo-${runId}-${index}` };
      const result = store.createEvent(event);
      eventIds.push(result.eventId);
      if (index === 0) store.createEvent(event);
    }
    res.status(202).json({ eventIds, duplicatePrevented: true });
  });
  app.post('/receivers/:id', jsonOnly, (req, res) => {
    const secret = store.getEndpointSecret(req.params.id);
    const eventId = req.headers['x-relaydesk-event'];
    const signature = req.headers['x-relaydesk-signature'];
    if (!secret || typeof eventId !== 'string' || typeof signature !== 'string' || !verify(secret, eventId, req.rawBody ?? '', signature)) {
      throw error('The delivery signature is missing, expired, or invalid.', 'INVALID_SIGNATURE', 401);
    }
    const result = store.receiveDemo(req.params.id, eventId);
    res.status(result.statusCode).json({ ...result.body, duplicate: result.duplicate });
  });

  const dist = resolve(ROOT, 'dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist, { index: 'index.html', maxAge: 0 }));
    app.get('/{*path}', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/receivers')) return next();
      res.sendFile(resolve(dist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.type('text/plain').send('RelayDesk API is running. Run npm run build to build the dashboard, or npm run dev:ui in another terminal.'));
  }
  app.use((_req, _res, next) => next(error('This route was not found.', 'NOT_FOUND', 404)));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the 16 KiB limit.' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
    if (err instanceof DomainError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    console.error('RelayDesk request failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  });
  return app;
}

export async function createService({ dbPath = resolve(ROOT, 'data/relaydesk.sqlite'), port = 4328, host = '127.0.0.1', startWorker = true, storeOptions = {}, workerOptions = {} } = {}) {
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Use the loopback host or Docker bind address.');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(dbPath, storeOptions);
  store.seedDemoEndpoints();
  const app = createApp({ store });
  const server = createServer(app);
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen); });
  } catch (err) { store.close(); throw err; }
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  app.locals.allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  app.locals.allowedOrigins = new Set([url, `http://localhost:${actualPort}`]);
  const worker = createWorker({ store, baseUrl: url, ...workerOptions });
  app.locals.worker = worker;
  if (startWorker) worker.start();
  let closed = false;
  return { app, server, store, worker, url, async close() {
    if (closed) return;
    closed = true;
    await worker.stop();
    server.closeIdleConnections();
    await new Promise((resolveClose, reject) => server.close(err => err ? reject(err) : resolveClose()));
    store.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error('RelayDesk requires Node.js 24. Install the current Node 24 LTS release.');
  const service = await createService({
    dbPath: process.env.RELAYDESK_DB ? resolve(process.env.RELAYDESK_DB) : undefined,
    port: Number(process.env.PORT || 4328),
    host: process.env.HOST || '127.0.0.1',
  });
  console.log(`RelayDesk is ready at ${service.url}`);
  console.log('Local demo receivers only. Press Ctrl+C to stop.');
  const shutdown = async () => { await service.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
