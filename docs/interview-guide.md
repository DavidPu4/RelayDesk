# RelayDesk interview walkthrough

## What problem does it solve

Applications often notify other services through webhooks. A receiver might be unavailable, a sender might time out after the receiver accepted a request, or a worker might crash while processing it. Retrying everything blindly can duplicate business effects; retrying nothing loses work.

RelayDesk makes those problems observable in a repeatable local lab. Its database records pending work, the worker sends signed HTTP requests, and the receiver records idempotent acceptance. The dashboard gives an operator enough evidence to decide when to repair a receiver and retry a failed delivery.

## A short explanation in your own words

“I built a webhook delivery workbench with a React and TypeScript dashboard and a Node.js/SQLite backend. It prevents duplicate event creation with an idempotency key and a canonical request fingerprint. The worker claims durable jobs using expiring leases, signs requests with HMAC, and retries temporary failures. I can deliberately break a receiver, show the failed attempts, repair it, and recover the same delivery without losing its history.”

This is a starting point for your explanation, not a script to memorize.

## Questions you should be able to answer

1. **Why does an idempotency key need a fingerprint?** A key alone cannot tell whether a caller is replaying the same request or accidentally using the key for different content. Identical content returns the existing result; conflicting reuse returns 409.
2. **What happens if a destination is invalid?** Ingestion validates all destinations inside the event transaction. Nothing is committed if any destination is missing or disabled.
3. **Why use a lease token?** An expiration time allows crash recovery. A random token fences the previous owner: after a new worker claims the delivery, the old owner's late completion cannot overwrite it.
4. **What happens on the final crashed attempt?** When its lease expires, the attempt is marked expired and the delivery becomes dead letter. Manual replay adds another budget and retains the abandoned attempt as evidence.
5. **Why is this at least once?** A timeout does not tell the sender whether the receiver applied the request. The receiver therefore also uses a unique event receipt to suppress repeated logical acceptance.
6. **Why sign the exact bytes?** A signature over parsed fields can overlook serialization or omitted fields. The signature binds the timestamp, event ID, and raw payload. A short timestamp window limits replay exposure, while receipt idempotency handles repeated valid deliveries.
7. **Why not retry every error?** A network failure or 503 can be temporary. A malformed request or unauthorized call usually needs a code/configuration fix. Retries have finite budgets and backoff to avoid hammering a failed service.
8. **Why SQLite?** It makes the whole project runnable without a database account or server, while still allowing real SQL transactions, constraints, durability, and concurrency tests. It limits write concurrency and deployment to one host.
9. **What would you change for a public service?** Add identity and tenant authorization, isolate signing secrets, authenticate destination management, apply SSRF-safe outbound controls, introduce quotas and monitoring, and use a database suited to multiple worker hosts.
10. **What did your tests prove?** Describe specific failures that were exercised. They do not prove a particular throughput, uptime target, or production readiness.

## Resume bullets

Use these only after you have run and understood the demo. Replace the older SVD project on a space-constrained resume so this project complements Bilingual Caption Studio.

- Built a webhook delivery platform with a React/TypeScript dashboard and Node.js/SQLite backend, including transactional event ingestion, idempotency keys, and HMAC-signed HTTP requests.
- Implemented durable job leases, capped exponential retries, and dead-letter recovery; prevented stale workers from overwriting reclaimed work and preserved delivery attempt history.
- Verified duplicate suppression, crash recovery, signature validation, and end-to-end failure repair with automated core and HTTP integration tests.

Keep the word **local** in your spoken demo context and explain the single-host limitation. Do not add claims about paying users, production traffic, cloud scale, or reliability percentages that you have not measured.

## Make it your own before applying

Complete at least one change yourself and add a test for it. Good bounded examples are honoring `Retry-After` for HTTP 429, adding an operator note to a replay, or implementing an event retention policy. Pick one, explain the design choice, and record what you learned. Be candid about AI assistance and which parts you understand and changed personally.
