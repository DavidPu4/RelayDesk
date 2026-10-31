# Verification results

Checked locally on October 31, 2026, with Node.js 24.19.0 on Windows x64.

- **31 automated tests passed:** 19 core tests, 8 HTTP integration tests, and 4 independent reliability tests. No failures or skipped tests.
- **Frontend production build passed:** strict TypeScript validation and Vite production bundling completed successfully.
- **Dependency installation:** 91 installed/audited packages; the installer reported zero known vulnerabilities at installation time. This is not a continuing security guarantee.
- **Browser workflow:** created the failure demo in the real dashboard, observed immediate success, transient recovery on attempt 3, and exhausted failure on attempt 4. Inspected persisted attempt history, changed the failing endpoint to healthy, and retried the same delivery. The dashboard showed success on attempt 5 and retained its previous four failures. Invalid JSON showed an inline validation error; a valid custom event was delivered and located through search. Browser error/warning logs were empty during these checks.
- **Repeatable CLI demo:** `node tools/demo.mjs` verified two delivered events, one exhausted dead letter, and one duplicate prevented. The ignored JSON report records the actual HTTP status of every attempt.
- **Persistence and ownership:** automated tests reopened a real SQLite file, claimed jobs through separate database connections, reclaimed expired leases, rejected stale owners, and checked exhausted final-lease recovery.
- **Request authentication:** tests rejected changed body bytes and expired signatures and verified successful retransmission creates only one logical receiver receipt.
- **Local access guards:** tests exercised forbidden browser origins, DNS-rebinding Host values, malformed JSON, oversized requests, unsupported media types, and bounded public queries.

Docker configuration is included but **was not built or run here** because the local Docker Desktop Linux engine was not running. GitHub Actions is configured but has not run on a remote repository. No throughput, availability, or production-scale benchmark has been established.

Synthetic events are labeled as demo data. All delivery states and activity metrics come from actual persisted HTTP attempts. Generated databases, screenshots, and machine-local evidence live in ignored directories and are excluded from the source repository.
