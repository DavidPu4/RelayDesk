import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BEHAVIORS = new Set(['healthy', 'flaky', 'failing']);
const STATUSES = new Set(['queued', 'processing', 'retrying', 'delivered', 'dead_letter']);
const id = (prefix) => `${prefix}_${randomUUID()}`;
const summarySQL = `SELECT d.id, d.event_id AS eventId, e.event_type AS eventType,
  d.endpoint_id AS endpointId, p.name AS endpointName, d.status,
  d.attempt_count AS attemptCount, d.max_attempts AS maxAttempts,
  d.created_at AS createdAt, d.updated_at AS updatedAt, d.next_attempt_at AS nextAttemptAt,
  d.last_status_code AS lastStatusCode, d.last_error AS lastError, d.delivered_at AS deliveredAt
  FROM deliveries d JOIN events e ON e.id=d.event_id JOIN endpoints p ON p.id=d.endpoint_id`;
const receiptSQL = `SELECT id, endpoint_id AS endpointId, event_id AS eventId,
  accepted_at AS acceptedAt, duplicate_count AS duplicateCount FROM receipts`;

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new DomainError(status, code, message);
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  throw new DomainError(400, 'invalid_payload', 'Payload must contain only JSON values.');
}

export class Store {
  constructor(path, { now = Date.now, random = Math.random, retryBaseMs = 1000, retryCapMs = 30000 } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.now = now;
    this.random = random;
    this.retryBaseMs = retryBaseMs;
    this.retryCapMs = retryCapMs;
    requireValue(Number.isFinite(retryBaseMs) && retryBaseMs > 0 && Number.isFinite(retryCapMs) && retryCapMs > 0,
      'invalid_retry_config', 'Retry intervals must be positive.');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, behavior TEXT NOT NULL CHECK(behavior IN ('healthy','flaky','failing')),
        enabled INTEGER NOT NULL DEFAULT 1, secret TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        duplicate_requests INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
        endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
        status TEXT NOT NULL CHECK(status IN ('queued','processing','retrying','delivered','dead_letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        next_attempt_at INTEGER, lease_token TEXT, leased_until INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        delivered_at INTEGER, last_status_code INTEGER, last_error TEXT,
        UNIQUE(event_id, endpoint_id)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,next_attempt_at,leased_until);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id),
        number INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        duration_ms REAL, status_code INTEGER, outcome TEXT NOT NULL,
        error TEXT, response_body TEXT NOT NULL DEFAULT '', UNIQUE(delivery_id,number)
      );
      CREATE INDEX IF NOT EXISTS attempts_activity ON attempts(finished_at,outcome);
      CREATE TABLE IF NOT EXISTS receiver_calls (
        endpoint_id TEXT NOT NULL REFERENCES endpoints(id), event_id TEXT NOT NULL REFERENCES events(id),
        calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(endpoint_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
        event_id TEXT NOT NULL REFERENCES events(id), accepted_at INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 0, UNIQUE(endpoint_id,event_id)
      );`);
  }

  close() { this.db.close(); }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seedDemoEndpoints() {
    if (this.db.prepare('SELECT COUNT(*) AS count FROM endpoints').get().count) return this.listEndpoints();
    for (const [name, behavior] of [['Orders service', 'healthy'], ['Inventory sync', 'flaky'], ['Warehouse service', 'failing']]) {
      this.createEndpoint({ name, behavior });
    }
    return this.listEndpoints();
  }

  listEndpoints() {
    return this.db.prepare(`SELECT id,name,behavior,enabled,created_at AS createdAt FROM endpoints ORDER BY created_at,id`).all()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  }

  createEndpoint({ name, behavior } = {}) {
    requireValue(typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80,
      'invalid_name', 'Endpoint name must contain 1 to 80 characters.');
    requireValue(BEHAVIORS.has(behavior), 'invalid_behavior', 'Choose healthy, flaky, or failing behavior.');
    const endpoint = { id: id('ep'), name: name.trim(), behavior, enabled: true, createdAt: this.now() };
    this.db.prepare('INSERT INTO endpoints(id,name,behavior,secret,created_at) VALUES(?,?,?,?,?)')
      .run(endpoint.id, endpoint.name, behavior, randomBytes(32).toString('base64url'), endpoint.createdAt);
    return endpoint;
  }

  updateEndpoint(endpointId, patch = {}) {
    const current = this.listEndpoints().find((row) => row.id === endpointId);
    requireValue(current, 'not_found', 'Endpoint not found.', 404);
    requireValue(patch && typeof patch === 'object' && !Array.isArray(patch), 'invalid_patch', 'Provide endpoint settings.');
    requireValue(Object.keys(patch).every((key) => key === 'behavior' || key === 'enabled'), 'invalid_patch', 'Only behavior and enabled can be updated.');
    if ('behavior' in patch) requireValue(BEHAVIORS.has(patch.behavior), 'invalid_behavior', 'Choose healthy, flaky, or failing behavior.');
    if ('enabled' in patch) requireValue(typeof patch.enabled === 'boolean', 'invalid_enabled', 'Enabled must be true or false.');
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE endpoints SET behavior=?,enabled=? WHERE id=?').run(next.behavior, Number(next.enabled), endpointId);
    return next;
  }

  getEndpointSecret(endpointId) {
    const row = this.db.prepare('SELECT secret FROM endpoints WHERE id=?').get(endpointId);
    return row?.secret ?? null;
  }

  createEvent({ type, payload, endpointIds, idempotencyKey, maxAttempts = 4 } = {}) {
    requireValue(typeof type === 'string' && type.trim().length > 0 && type.trim().length <= 80,
      'invalid_type', 'Event type must contain 1 to 80 characters.');
    requireValue(typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0 && idempotencyKey.length <= 128,
      'invalid_idempotency_key', 'Idempotency key must contain 1 to 128 characters.');
    requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'invalid_payload', 'Payload must be a JSON object.');
    requireValue(Array.isArray(endpointIds) && endpointIds.length >= 1 && endpointIds.length <= 10 &&
      endpointIds.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 128),
      'invalid_endpoints', 'Choose 1 to 10 valid endpoints.');
    requireValue(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 8,
      'invalid_attempt_budget', 'Maximum attempts must be between 1 and 8.');
    const destinations = [...new Set(endpointIds)].sort();
    let payloadJson;
    try { payloadJson = JSON.stringify(canonical(payload)); } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(400, 'invalid_payload', 'Payload must contain finite, acyclic JSON values.');
    }
    requireValue(Buffer.byteLength(payloadJson) <= 16 * 1024, 'payload_too_large', 'Payload must be at most 16 KiB.', 413);
    const eventType = type.trim();
    const fingerprint = createHash('sha256').update(JSON.stringify({ type: eventType, payload: payloadJson, destinations, maxAttempts })).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,fingerprint FROM events WHERE idempotency_key=?').get(idempotencyKey);
      if (existing) {
        requireValue(existing.fingerprint === fingerprint, 'idempotency_conflict', 'This idempotency key was already used for different content.', 409);
        this.db.prepare('UPDATE events SET duplicate_requests=duplicate_requests+1 WHERE id=?').run(existing.id);
        return { eventId: existing.id,
          deliveryIds: this.db.prepare('SELECT id FROM deliveries WHERE event_id=? ORDER BY endpoint_id').all(existing.id).map((row) => row.id),
          replayed: true };
      }
      for (const endpointId of destinations) {
        const endpoint = this.db.prepare('SELECT enabled FROM endpoints WHERE id=?').get(endpointId);
        requireValue(endpoint, 'endpoint_not_found', 'An endpoint does not exist.', 404);
        requireValue(endpoint.enabled, 'endpoint_disabled', 'Enable every selected endpoint before sending an event.', 409);
      }
      const eventId = id('evt');
      const now = this.now();
      this.db.prepare('INSERT INTO events(id,event_type,payload_json,idempotency_key,fingerprint,created_at) VALUES(?,?,?,?,?,?)')
        .run(eventId, eventType, payloadJson, idempotencyKey, fingerprint, now);
      const deliveryIds = destinations.map((endpointId) => {
        const deliveryId = id('dly');
        this.db.prepare(`INSERT INTO deliveries(id,event_id,endpoint_id,status,max_attempts,next_attempt_at,created_at,updated_at)
          VALUES(?,?,?,'queued',?,?,?,?)`).run(deliveryId, eventId, endpointId, maxAttempts, now, now, now);
        return deliveryId;
      });
      return { eventId, deliveryIds, replayed: false };
    });
  }

  listDeliveries({ status, query = '', limit = 100 } = {}) {
    requireValue(!status || status === 'all' || STATUSES.has(status), 'invalid_status', 'Unknown delivery status.');
    requireValue(typeof query === 'string' && query.length <= 200, 'invalid_query', 'Search must contain at most 200 characters.');
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 200, 'invalid_limit', 'Limit must be between 1 and 200.');
    const conditions = [];
    const params = [];
    if (status && status !== 'all') { conditions.push('d.status=?'); params.push(status); }
    if (query) {
      conditions.push("(e.id LIKE ? ESCAPE '\\' OR e.event_type LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')");
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(pattern, pattern, pattern);
    }
    params.push(limit);
    return this.db.prepare(`${summarySQL}${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`)
      .all(...params).map((row) => ({ ...row }));
  }

  getDelivery(deliveryId) {
    const delivery = this.db.prepare(`${summarySQL} WHERE d.id=?`).get(deliveryId);
    requireValue(delivery, 'not_found', 'Delivery not found.', 404);
    const event = this.db.prepare('SELECT payload_json FROM events WHERE id=?').get(delivery.eventId);
    const attempts = this.db.prepare(`SELECT id,number,started_at AS startedAt,finished_at AS finishedAt,
      duration_ms AS durationMs,status_code AS statusCode,outcome,error,response_body AS responseBody
      FROM attempts WHERE delivery_id=? ORDER BY number`).all(deliveryId).map((row) => ({ ...row }));
    const receipt = this.db.prepare(`${receiptSQL} WHERE endpoint_id=? AND event_id=?`).get(delivery.endpointId, delivery.eventId);
    return { ...delivery, payload: JSON.parse(event.payload_json), attempts, receipt: receipt ? { ...receipt } : null };
  }

  listReceipts() {
    return this.db.prepare(`${receiptSQL} ORDER BY accepted_at DESC,id LIMIT 1000`).all().map((row) => ({ ...row }));
  }

  retryDelivery(deliveryId) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT status,attempt_count FROM deliveries WHERE id=?').get(deliveryId);
      requireValue(current, 'not_found', 'Delivery not found.', 404);
      requireValue(current.status === 'dead_letter', 'not_retryable', 'Only dead-letter deliveries can be replayed.', 409);
      const now = this.now();
      this.db.prepare(`UPDATE deliveries SET status='queued',max_attempts=attempt_count+4,next_attempt_at=?,
        lease_token=NULL,leased_until=NULL,updated_at=?,last_error=NULL WHERE id=?`).run(now, now, deliveryId);
      const { attempts, payload, receipt, ...summary } = this.getDelivery(deliveryId);
      return summary;
    });
  }

  claimNext({ leaseMs = 15000 } = {}) {
    requireValue(Number.isInteger(leaseMs) && leaseMs > 0, 'invalid_lease', 'Lease duration must be positive.');
    return this.transaction(() => {
      const now = this.now();
      const expired = this.db.prepare("SELECT id,attempt_count,max_attempts FROM deliveries WHERE status='processing' AND leased_until<=?").all(now);
      for (const row of expired) {
        this.db.prepare(`UPDATE attempts SET outcome='lease_expired',finished_at=?,duration_ms=MAX(0,?-started_at),
          error='Worker lease expired before completion.' WHERE delivery_id=? AND number=? AND outcome='in_progress'`)
          .run(now, now, row.id, row.attempt_count);
        this.db.prepare(`UPDATE deliveries SET status=?,lease_token=NULL,leased_until=NULL,next_attempt_at=?,updated_at=?,
          last_error='Worker lease expired before completion.' WHERE id=?`)
          .run(row.attempt_count >= row.max_attempts ? 'dead_letter' : 'queued', row.attempt_count >= row.max_attempts ? null : now, now, row.id);
      }
      const row = this.db.prepare(`SELECT d.id,d.event_id,d.endpoint_id,d.attempt_count,e.event_type,e.payload_json,p.secret
        FROM deliveries d JOIN events e ON e.id=d.event_id JOIN endpoints p ON p.id=d.endpoint_id
        WHERE d.status IN ('queued','retrying') AND d.next_attempt_at<=? AND d.attempt_count<d.max_attempts
        ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1`).get(now);
      if (!row) return null;
      const token = randomUUID();
      const number = row.attempt_count + 1;
      this.db.prepare(`UPDATE deliveries SET status='processing',attempt_count=?,lease_token=?,leased_until=?,updated_at=? WHERE id=?`)
        .run(number, token, now + leaseMs, now, row.id);
      this.db.prepare(`INSERT INTO attempts(id,delivery_id,number,started_at,outcome) VALUES(?,?,?,?,'in_progress')`)
        .run(id('att'), row.id, number, now);
      return { id: row.id, eventId: row.event_id, endpointId: row.endpoint_id, type: row.event_type,
        payloadJson: row.payload_json, secret: row.secret, leaseToken: token, attemptNumber: number };
    });
  }

  completeDelivery(deliveryId, leaseToken, { ok, statusCode = null, error = null, responseBody = '', durationMs = 0 } = {}) {
    return this.transaction(() => {
      const now = this.now();
      const current = this.db.prepare("SELECT * FROM deliveries WHERE id=? AND status='processing' AND lease_token=? AND leased_until>?")
        .get(deliveryId, leaseToken, now);
      if (!current) return false;
      const success = statusCode !== null ? statusCode >= 200 && statusCode < 300 : Boolean(ok);
      const retryable = statusCode === null || [408, 425, 429].includes(statusCode) || statusCode >= 500;
      const shouldRetry = !success && retryable && current.attempt_count < current.max_attempts;
      const outcome = success ? 'delivered' : 'failed';
      const status = success ? 'delivered' : shouldRetry ? 'retrying' : 'dead_letter';
      const errorText = success ? null : String(error || (statusCode ? `Receiver returned HTTP ${statusCode}.` : 'Delivery failed.')).slice(0, 1024);
      const elapsed = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
      const body = String(responseBody ?? '').slice(0, 1024);
      this.db.prepare(`UPDATE attempts SET finished_at=?,duration_ms=?,status_code=?,outcome=?,error=?,response_body=?
        WHERE delivery_id=? AND number=? AND outcome='in_progress'`)
        .run(now, elapsed, statusCode, outcome, errorText, body, deliveryId, current.attempt_count);
      const boundedRandom = Math.max(0, Math.min(1, Number(this.random()) || 0));
      const delay = Math.max(1, Math.min(this.retryCapMs,
        Math.round(this.retryBaseMs * 2 ** Math.min(current.attempt_count - 1, 30) * (0.8 + boundedRandom * 0.4))));
      this.db.prepare(`UPDATE deliveries SET status=?,next_attempt_at=?,lease_token=NULL,leased_until=NULL,
        updated_at=?,delivered_at=?,last_status_code=?,last_error=? WHERE id=?`)
        .run(status, shouldRetry ? now + delay : null, now, success ? now : null, statusCode, errorText, deliveryId);
      return true;
    });
  }

  receiveDemo(endpointId, eventId) {
    return this.transaction(() => {
      const endpoint = this.db.prepare('SELECT behavior FROM endpoints WHERE id=?').get(endpointId);
      requireValue(endpoint, 'not_found', 'Endpoint not found.', 404);
      const delivery = this.db.prepare('SELECT id FROM deliveries WHERE endpoint_id=? AND event_id=?').get(endpointId, eventId);
      requireValue(delivery, 'unknown_event', 'This event is not addressed to this receiver.', 404);
      this.db.prepare(`INSERT INTO receiver_calls(endpoint_id,event_id,calls) VALUES(?,?,1)
        ON CONFLICT(endpoint_id,event_id) DO UPDATE SET calls=calls+1`).run(endpointId, eventId);
      const { calls } = this.db.prepare('SELECT calls FROM receiver_calls WHERE endpoint_id=? AND event_id=?').get(endpointId, eventId);
      if (endpoint.behavior === 'failing' || (endpoint.behavior === 'flaky' && calls <= 2)) {
        return { statusCode: 503, body: { accepted: false, message: 'Synthetic receiver failure.', call: calls }, duplicate: false };
      }
      const existing = this.db.prepare('SELECT id FROM receipts WHERE endpoint_id=? AND event_id=?').get(endpointId, eventId);
      if (existing) {
        this.db.prepare('UPDATE receipts SET duplicate_count=duplicate_count+1 WHERE id=?').run(existing.id);
      } else {
        this.db.prepare('INSERT INTO receipts(id,endpoint_id,event_id,accepted_at) VALUES(?,?,?,?)')
          .run(id('rct'), endpointId, eventId, this.now());
      }
      return { statusCode: 200, body: { accepted: true, duplicate: Boolean(existing), message: existing ? 'Previously accepted; no second logical acceptance.' : 'Event accepted.' }, duplicate: Boolean(existing) };
    });
  }

  overview() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status').all().map((row) => [row.status, row.count]));
    const totalEvents = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(duplicate_requests),0) AS duplicates FROM events').get();
    const delivered = counts.delivered || 0;
    const deadLetter = counts.dead_letter || 0;
    const { recovered } = this.db.prepare("SELECT COUNT(*) AS recovered FROM deliveries WHERE status='delivered' AND attempt_count>1").get();
    const { latency } = this.db.prepare("SELECT AVG(duration_ms) AS latency FROM attempts WHERE outcome IN ('delivered','failed')").get();
    const currentHour = Math.floor(this.now() / 3_600_000) * 3_600_000;
    const activity = Array.from({ length: 12 }, (_, index) => {
      const hour = currentHour - (11 - index) * 3_600_000;
      return { hour, label: new Date(hour).toISOString().slice(11, 16), delivered: 0, failed: 0 };
    });
    const attempts = this.db.prepare(`SELECT (finished_at / 3600000) * 3600000 AS hour,outcome,COUNT(*) AS count
      FROM attempts WHERE finished_at>=? AND finished_at<? AND outcome IN ('delivered','failed','lease_expired')
      GROUP BY hour,outcome`).all(activity[0].hour, currentHour + 3_600_000);
    for (const attempt of attempts) {
      const bucket = activity.find((value) => value.hour === attempt.hour);
      if (bucket) bucket[attempt.outcome === 'delivered' ? 'delivered' : 'failed'] += attempt.count;
    }
    return { totalEvents: totalEvents.count, totalDeliveries: Object.values(counts).reduce((sum, value) => sum + value, 0),
      delivered, retrying: counts.retrying || 0, queued: counts.queued || 0, processing: counts.processing || 0,
      deadLetter, duplicatesPrevented: totalEvents.duplicates, recovered,
      successRate: delivered + deadLetter ? Math.round(delivered / (delivered + deadLetter) * 1000) / 10 : null,
      avgLatencyMs: latency === null ? null : Math.round(latency * 10) / 10, activity };
  }
}
