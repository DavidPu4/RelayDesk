# RelayDesk implementation contract

RelayDesk is a local webhook reliability workbench. The UI displays actual persisted delivery data, never fabricated metrics. Synthetic example events are clearly identified. The background worker sends real HTTP requests to the included receivers. No external APIs, credentials, billing, or cloud accounts are required.

## HTTP API

All timestamps are epoch milliseconds. Every failure is `{error:{code,message}}`. Endpoint behavior is `healthy | flaky | failing`. Delivery status is `queued | processing | retrying | delivered | dead_letter`.

- GET `/api/health`: `{status:'ok', version:'1.0.0', workerRunning:boolean}`.
- GET `/api/overview`: overview below.
- GET `/api/endpoints`: `{items:Endpoint[]}`. Signing secrets are never returned.
- POST `/api/endpoints`: `{name,behavior}` -> Endpoint (201).
- PATCH `/api/endpoints/:id`: `{behavior?,enabled?}` -> Endpoint.
- GET `/api/deliveries?status=&q=&limit=100`: `{items:Delivery[]}`. `q` searches event ID, event type, or endpoint name. Status `all` or omitted means unfiltered.
- GET `/api/deliveries/:id`: DeliveryDetail.
- POST `/api/deliveries/:id/retry`: no body; dead-letter only; adds another four-attempt budget without deleting attempt history. Returns Delivery.
- POST `/api/events`: `{type,payload,endpointIds,idempotencyKey,maxAttempts?:4}` -> `{eventId,deliveryIds,replayed}` (202 on create, 200 on replay). Identical key + different content -> 409. Type matches `[A-Za-z][A-Za-z0-9_.:-]{0,79}`; key matches `[A-Za-z0-9_.:-]{1,128}`; payload JSON object; 1-10 destinations; maxAttempts 1-8; body limit 16 KiB.
- POST `/api/demo/run`: creates one healthy, one flaky, one failing event and deliberately replays the healthy request once. `{eventIds,duplicatePrevented:true}`. Uses existing endpoints matching each behavior or creates one if needed. The demo is synthetic; all deliveries are real.
- GET `/api/receipts`: `{items:Receipt[]}` for interview inspection.
- POST `/receivers/:endpointId`: internal demo receiver; signed delivery requests only, not a general public ingestion API.

Endpoint = `{id,name,behavior,enabled,createdAt}`.

Delivery = `{id,eventId,eventType,endpointId,endpointName,status,attemptCount,maxAttempts,createdAt,updatedAt,nextAttemptAt,lastStatusCode,lastError,deliveredAt}`.

DeliveryDetail extends Delivery with `{payload, attempts:Attempt[], receipt:Receipt|null}`.

Attempt = `{id,number,startedAt,finishedAt,durationMs,statusCode,outcome,error,responseBody}`. Outcome: `in_progress | delivered | failed | lease_expired`.

Receipt = `{id,endpointId,eventId,acceptedAt,duplicateCount}`.

Overview = `{totalEvents,totalDeliveries,delivered,retrying,queued,processing,deadLetter,duplicatesPrevented,recovered,successRate,avgLatencyMs,activity}`. successRate is percentage 0-100 or null without completed deliveries; avgLatencyMs is mean completed HTTP attempt latency or null. `activity` has 12 hourly buckets `{hour,label,delivered,failed}` based on persisted attempts. recovered counts delivered rows with attemptCount > 1.

## Core module interface

`src/backend/store.js` exports `Store`, `DomainError`. `new Store(path,{now=Date.now, random=Math.random, retryBaseMs=1000, retryCapMs=30000}={})` creates schema, WAL, foreign keys and busy timeout. Methods:

- `close()`, `seedDemoEndpoints()`, `listEndpoints()`, `createEndpoint({name,behavior})`, `updateEndpoint(id,patch)`, `getEndpointSecret(id)` (internal only).
- `createEvent({type,payload,endpointIds,idempotencyKey,maxAttempts=4})` atomically writes event + deliveries or detects replay/conflict. Exact JSON key ordering should not cause false conflicts: canonicalize object keys recursively.
- `listDeliveries({status,query,limit=100}={})`, `getDelivery(id)`, `overview()`, `listReceipts()`.
- `retryDelivery(id)` returns summary; dead_letter only; `maxAttempts=attemptCount+4`, preserve history.
- `claimNext({leaseMs=15000}={})` atomically claims eligible work via BEGIN IMMEDIATE. Returns null or `{id,eventId,endpointId,type,payloadJson,secret,leaseToken,attemptNumber}`. Insert an in_progress attempt atomically when claiming. Reclaim expired processing leases, close previous attempt as lease_expired, fence old owners. Exhausted expired work becomes dead_letter.
- `completeDelivery(id,leaseToken,{ok,statusCode=null,error=null,responseBody='',durationMs=0})` atomically finishes only current owner; stale owner returns false. Use capped exponential backoff with +/-20% jitter on retryable failures (network errors, 408, 425, 429, 5xx); other HTTP failures become dead_letter immediately; all 2xx succeed. Never retry past budget.
- `receiveDemo(endpointId,eventId)` returns `{statusCode,body,duplicate}`. healthy accepts, flaky returns 503 on first two calls for that endpoint/event, failing always 503. Accepted receipt has UNIQUE(endpoint_id,event_id), subsequent successful requests increment duplicateCount without a second logical acceptance. Endpoint-disabled deliveries are rejected during event creation; already queued jobs remain deliverable.

DomainError has `.status`, `.code`, `.message`.

`src/backend/signing.js` exports `sign(secret,eventId,rawBody,timestampSeconds)` -> `t=...,v1=...`, `verify(secret,eventId,rawBody,signature,nowMs=Date.now())` -> boolean. HMAC-SHA256 over `timestamp.eventId.rawBody`, constant-time comparison, 5-minute age window, reject malformed signatures.

`src/backend/worker.js` exports `createWorker({store,baseUrl,concurrency=3,pollMs=150,timeoutMs=1200,fetchImpl=fetch})` -> `{start(),async stop(),async tick(),get running()}`. Only constructs URLs from baseUrl + `/receivers/` + encoded endpoint IDs. Outgoing signed headers: `X-RelayDesk-Event`, `X-RelayDesk-Delivery`, `X-RelayDesk-Signature`. JSON raw body is the event payload. HTTP timeout enforced; redirect:'error'; bound response excerpt to 1024 characters; no arbitrary outbound URL input. stop aborts in-flight requests, leaves leases recoverable rather than falsely finalizing shutdown cancellations.

## Frontend

React + TypeScript + Vite; `src/frontend/main.tsx`, `App.tsx`, `styles.css`, optional components. Root owns package.json, tsconfig.json, vite.config.ts, index.html, HTTP server, README and infrastructure. Frontend agent owns only src/frontend. Core agent owns only store.js, signing.js, worker.js and tests/core.test.js. Native Node 24 node:sqlite; no Python dependency.

Frontend uses relative `/api` paths, polls every ~1.5s (cancel and avoid overlap). Desktop-first responsive dark sidebar/light workspace, green success/amber retry/red failure badges. Sidebar navigation must work. Include delivery search/status filtering, detail drawer with payload + actual attempt timeline, new-event dialog with JSON validation, endpoint behavior repair controls, dead-letter retry, and a one-click Run failure demo action. Dashboard can honestly start empty; explain synthetic examples before running. Accessible dialogs, keyboard dismissal/focus, explicit loading/error/empty states. Do not put architecture jargon into ordinary task controls.
