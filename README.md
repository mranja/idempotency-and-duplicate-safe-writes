# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

#### 1. Why database uniqueness is needed
In distributed and multi-threaded systems, multiple requests carrying the exact same idempotency key may arrive concurrently across different processes, containers, or server instances. Application-level checks (such as a naive `SELECT` followed by `INSERT`) suffer from race conditions (check-then-act) where concurrent requests both observe that the key does not exist and both proceed to create duplicate incidents.

A database-level unique constraint (`CONSTRAINT uq_idempotency_keys_tenant_op_key UNIQUE (tenant_id, operation, key)`) provides an ACID-level, atomic enforcement boundary at the single source of truth. Even in high-concurrency environments, PostgreSQL guarantees that only one transaction can successfully claim or commit ownership of a given `(tenant_id, operation, key)` tuple. Combined with transaction-level advisory locks (`pg_advisory_xact_lock`), sequential and concurrent duplicates are serialized and resolved cleanly without race conditions.

#### 2. How request contents are canonicalized and compared
JSON objects in HTTP request payloads do not guarantee deterministic key ordering (e.g., `{"title":"x","severity":"P1"}` vs `{"severity":"P1","title":"x"}`). If a client retries a request with reordered JSON properties, standard string hashing would produce different digests, leading to false conflicts.

To solve this, we implement deterministic recursive canonicalization (`canonicalize`) that lexicographically sorts all object keys at every level before serialization. The resulting normalized string is then digested using SHA-256 (`hashRequest`). When an idempotency key is reused:
- If the incoming request hash matches the stored `request_hash`, it is recognized as a genuine duplicate and replayed.
- If the incoming request hash differs from the stored `request_hash`, the handler rejects the request with HTTP `409` and `{ "error": "idempotency_key_conflict" }`, preventing dangerous payload substitution under an existing key.

#### 3. What 24-hour expiry means
Idempotency keys are designed to provide safety across temporary retry windows (such as network hiccups, client reconnects, dropped responses, or gateway timeouts). They are not intended to represent permanent, unbounded deduplication for all time.

The 24-hour expiry window (`expires_at = now() + interval '24 hours'`):
- Defines the SLA for client retries: within 24 hours, the exact result of the original request is reliably replayed, and mutations are prevented.
- Enables safe storage reclamation: expired keys can be safely pruned or overwritten, preventing the idempotency table from growing unbounded over time.
- Clarifies recovery expectations: after 24 hours, the idempotency window has lapsed, allowing clients to initiate a fresh operation with that key if necessary.

#### 4. Why paging job is stored in same transaction
Creating an incident and dispatching an on-call paging alert is a classic distributed dual-write problem. If the paging alert were sent to an external service or message broker directly within the request handler without transactional guarantees:
- **Crash / failure before dispatch:** The incident is committed to the database, but the paging call fails or the process crashes beforehand, resulting in an un-paged critical incident (silent alert failure).
- **Failure after dispatch:** The paging call succeeds, but the database transaction subsequently rolls back (e.g., DB constraint failure or connection drop), paging on-call engineers for a non-existent incident.
- **External delays:** Calling external APIs inside a database transaction holds database locks open, degrading database throughput.

By implementing the **Transactional Outbox Pattern**—inserting the durable paging job (`paging_jobs`) atomically in the exact same database transaction as the incident and idempotency key—we guarantee that either both the incident and its paging job exist, or neither exists. An asynchronous worker can then reliably read and process pending paging jobs with at-least-once delivery guarantees.

#### 5. Privacy and size risks of stored responses
Caching and storing full HTTP response bodies (`response_body JSONB`) in the idempotency table introduces two primary operational risks:
- **Privacy, PII, and Security:** Response payloads may contain sensitive personal data (PII), customer identifiers, tokens, or confidential incident details. Storing these in an idempotency cache increases the blast radius and complicates compliance with data privacy regulations (e.g., GDPR/CCPA "Right to Erasure"). If a user requests deletion of their personal data, idempotency tables must also be audited and redacted.
- **Storage and Performance Bloat:** If API responses include large payloads (e.g., lengthy stack traces, system diagnostics, or embedded attachments), storing full JSONB responses can quickly cause table and index bloat, degrading database buffer pool hit ratios and increasing backup sizes.
- **Mitigations:** Production systems should store only minimal response projections (e.g., resource IDs and HTTP status codes) where possible, apply field-level encryption/masking to sensitive attributes, and strictly enforce the 24-hour TTL with automated partition drops or background vacuuming.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
