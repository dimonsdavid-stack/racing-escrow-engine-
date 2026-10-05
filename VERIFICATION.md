# Verification record — 1.1.0 — 2026-10-04

Executed in the supplied workspace with Node 24.19.0:

- `npm test`: **31 passed, 0 failed, 0 skipped**.
- `npm audit --omit=dev`: **0 vulnerabilities reported** by the registry audit.
- Syntax checks passed for the HTTP service, refund worker, signing utility,
  logging/retry modules and expanded native PostgreSQL concurrency suite.
- CI/Compose YAML parsed successfully. Configuration assertions verified the
  PostgreSQL 15/17 matrix, read-only GitHub token permissions, action SHA pins,
  the explicit disposable-database flag and absence of a host-published test DB port.

Database tests executed the actual schema and SQL functions in PGlite 0.5.8.
They tested service-role execution, denied direct table mutations, tenant/SC
isolation, exact rake arithmetic, journal conservation and drift detection,
idempotency, late telemetry rejection and full zero-fee refunds. Injected
failures occurred after attempted wallet/treasury changes but before final-event
receipt insertion; the database rolled those changes back and the same event
succeeded on retry.

A real HTTP-to-database integration verified the raw-body HMAC, winner
calculation, SQL settlement and durable receipt replay. A re-signed changed
body using the same event UUID was rejected without a second payout.

Additional tests verified that a caller cannot change retry arguments while a
response is pending, missing HTTP status does not make a conflict retryable,
dirty laps with malformed/absent times are fully disregarded, and synchronous
or asynchronous logging failures cannot alter committed outcomes. Installation
preserves grants on unrelated public function overloads.

Deployment tests verified that missing or malformed secrets leave HTTP health
available while settlement returns 503 without any RPC; configured unsigned
requests still return 401. The Vercel default export imports without secrets,
serves the mobile status page and its module/CSS assets, and does not expose
environment or SQL files. The status API explicitly leaves database connectivity
unchecked. No external GitHub push or Vercel deployment has completed.

**Native concurrent-session tests are included but were not executed here.**
No native PostgreSQL server or disposable remote test database was available.
PGlite serializes its single database session and is not a substitute for
independent-connection lock-contention tests. The expanded suite includes 11
native scenarios, including observed lock waits, committed/rolled-back first
attempts, backend cancellation during posting, SERIALIZABLE funding conflicts,
and simultaneous GC/SC funding. Run `npm run test:concurrency`
against a fresh disposable PostgreSQL/Supabase-compatible database using the
environment variables described in README.md before production release.

The GitHub Actions workflow and nonroot Docker/Compose configuration are
included as runnable source. No connected repository workflow was executed,
and no Docker image was built in this Docker-free workspace. The native suite
is mandatory in `test:all`; it does not silently skip when a database is absent.

No Supabase project was modified and no service was deployed. Provider signing
keys, user provisioning, consent checks, TLS/gateway configuration, timeout
scheduling, database durability/restore verification and external cash custody
remain deployment/integration responsibilities. The supplied code implements
the ledger and telemetry core; it does not assert those external systems exist.
