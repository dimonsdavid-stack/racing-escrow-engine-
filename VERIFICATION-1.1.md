# Verification record — 1.1.0 — 2026-10-05

Production URL: https://racing-escrow-engine.vercel.app/
Repository: https://github.com/dimonsdavid-stack/racing-escrow-engine-
Initial engine commit: `416f65209e1245bb13fb0c5dad633a837f556075`.
Vercel project: `prj_VcK7s2BN3AY78hp6frEg8JUInaeq`, team 720studios.
Initial production deployment: `dpl_ESAr14mzzEK2LMBLbrUpv6XpzLLr`.
Deployment state: READY; Express; Node.js 24.x.

GitHub Actions run:
https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/runs/37382261106

Both PostgreSQL 15 and PostgreSQL 17 jobs completed successfully, including
locked dependency installation, deterministic HTTP/SQL tests, native
independent-session concurrency tests, production dependency audit and test
report upload. The registry audit reported zero production vulnerabilities.

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
unchecked. The full engine source has been pushed and deployed to production.

**Native concurrent-session tests passed on PostgreSQL 15 and 17 in CI.**
No native PostgreSQL server was available in the local workspace; GitHub's
disposable service containers executed the suite successfully.
PGlite serializes its single database session and is not a substitute for
independent-connection lock-contention tests. The expanded suite includes 11
native scenarios, including observed lock waits, committed/rolled-back first
attempts, backend cancellation during posting, SERIALIZABLE funding conflicts,
and simultaneous GC/SC funding. Run `npm run test:concurrency`
against a fresh disposable PostgreSQL/Supabase-compatible database using the
environment variables described in README.md before production release.

The GitHub Actions workflow executed successfully against the connected
repository. No production Docker image was built in this Docker-free workspace. The native suite
is mandatory in `test:all`; it does not silently skip when a database is absent.

No production Supabase project was modified and no live wallet was funded or
settled. The hosted service is deployed with settlement deliberately disabled.
Provider signing
keys, user provisioning, consent checks, TLS/gateway configuration, timeout
scheduling, database durability/restore verification and external cash custody
remain deployment/integration responsibilities. The supplied code implements
the ledger and telemetry core; it does not assert those external systems exist.

Direct unauthenticated curl requests, without cookies or bypass credentials,
verified the public production domain:

| Route | Result |
|---|---|
| `GET /` | 200; mobile status HTML |
| `GET /healthz` | 200; `{"status":"ok"}` |
| `GET /api/v1/status` | 200; settlement `configuration_required`, connectivity `unchecked` |
| `POST /api/v1/telemetry/settle` with unsigned `{}` | 503; `service_not_configured` |
| `GET /service.css` and `/status.js` | 200 |
| `GET /.env` and `/sql/001_engine.sql` | 404 |

Response headers include no-store caching, nosniff, HTTPS transport security
and restrictive content security policies. Production ledger installation,
server credentials, tenant/provider/wallet provisioning, signing keys, the
refund scheduler and a signed production GC smoke test remain to be configured.
