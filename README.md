# Racing Escrow Engine

An executable Node.js/Express and PostgreSQL core for two-participant GC/SC
challenge funding, signed race telemetry, settlement, and zero-fee refunds.
The included REST surface is a **trusted telemetry-provider webhook**, not a
browser endpoint for spending another participant's balance.

Production service: https://racing-escrow-engine.vercel.app/
Source: https://github.com/dimonsdavid-stack/racing-escrow-engine-
The service is deployed; settlement remains disabled until server credentials,
the racing ledger, provider identities and the refund scheduler are provisioned.

## Source map

| File | Purpose |
|---|---|
| `sql/001_engine.sql` | Complete fresh-install DDL, private ledger, grants, escrow and settlement RPCs |
| `sql/002_call_example.sql` | Explicit `BEGIN ISOLATION LEVEL SERIALIZABLE` / `COMMIT` funding example |
| `sql/003_reconcile.sql` | Read-only wallet, escrow and treasury reconciliation against journal entries |
| `src/telemetry.js` | Strict payload validation, clean-lap filtering, microsecond minimums and winner calculation |
| `src/signature.js` | Raw-body HMAC verification and tenant/provider key binding |
| `src/settlement.js` | Supabase JS integration; single atomic RPC per attempt; safe retry handling |
| `src/app.js` | `POST /api/v1/telemetry/settle` and liveness endpoint |
| `server.js` / `src/runtime.js` / `vercel.json` | Vercel Express entrypoint and disabled settlement when server configuration is missing |
| `public/` / `DEPLOYMENT.md` | Mobile-friendly service status page and deployment instructions |
| `src/server.js` | Configuration checks, HTTP limits and graceful shutdown |
| `src/sweep.js` | Expired-session refund worker |
| `src/logging.js` | Sync/async logging failures isolated from committed financial outcomes |
| `test/` | SQL, HTTP, integration, failure injection and native concurrency tests |
| `.github/workflows/verify.yml` | Required-check workflow with native PostgreSQL 15/17 service containers |
| `Dockerfile` / `compose.test.yaml` | Nonroot runtime image and disposable native test cluster |

Node dependencies are pinned in `package.json` and the lockfile. Node 24+ is
required. No account balance uses JavaScript `Number` arithmetic.

## Ledger and transaction contract

Each user has independent `numeric(24,6)` GC and SC balances. Challenge entry
fees must be positive, at most 1,000,000 coins, and have at most two decimal
places. Inputs with excess fee precision are rejected rather than rounded.
Promotional grants allow six decimal places. Monetary RPC inputs and responses
use decimal strings in the Node integration.

For entry fee `e`, creation stores:

```text
gross_pool     = 2 × e
reserved_rake  = gross_pool × 0.10
winner_payout  = gross_pool − reserved_rake
```

With the two-decimal entry quantum, the rake is exactly representable in the
six-decimal wallet denomination. For `e = 10.00`, the pool is 20.00, rake 2.00,
and winner payout 18.00. For `e = 0.01`, rake is 0.002000; it is not rounded to
a cent or silently discarded.

`total_escrow_pool` is immutable historical funding metadata.
`remaining_escrow` is the live liability, initially equal to the gross pool and
set to zero on completion. Rake is reserved at creation and credited to the
same currency's tenant treasury **only on a winner settlement**. Every refund
returns exactly `e` to each participant and charges zero rake.

All monetary mutations have one database boundary:

1. Lock the challenge or funding request identity.
2. Lock both participant rows in canonical UUID order.
3. Validate current balances or the challenge's final-event binding.
4. Mutate wallets, escrow and any treasury credit.
5. Append a balanced journal transaction and final-event receipt.
6. Commit together, or roll back together on any database exception.

Funding uses transaction-scoped advisory locks to serialize an idempotent
request ID. Wallets use `FOR NO KEY UPDATE`: it protects balance mutations while
remaining compatible with foreign-key key-share locks. Settlement and timeout
refunds use the **same challenge row lock**. Unique indexes permit only one
funding transaction and one completion journal transaction per challenge.

For every tenant and currency, absent an intentional grant:

```text
sum(user balances) + sum(remaining escrow) + treasury balance = constant
```

Grants increase outstanding tokens and record equal negative Issuance postings.
Every journal transaction has at least two lines and `sum(delta) = 0`, enforced
by deferred constraint triggers at commit. Journal records and final-event
receipts reject updates/deletes. `003_reconcile.sql` independently compares
the journal projection with current asset balances and should return no rows.

GC and SC never convert or share an escrow or treasury balance. The token type
is fixed at challenge funding and cannot be selected by incoming telemetry.

### Transaction semantics

PL/pgSQL's `BEGIN ... END` is a procedural block, not a nested transaction.
PostgreSQL functions cannot independently `COMMIT` inside an RPC. The DDL and
the standalone SQL call example include explicit outer `BEGIN ... COMMIT`.
PostgREST runs each POST RPC in its own read-write transaction. Ordered row
locks and protected mutation paths provide the balance invariant at PostgreSQL's
default READ COMMITTED isolation. For callers using SERIALIZABLE, retry the
entire function call on `40001` with the identical request identity.

A database error rolls back all uncommitted changes. A lost HTTP response or
client abort can occur **after commit**: it cannot establish rollback. Retry
the exact same event ID and bytes. The stored receipt returns the existing
result without issuing another payout. No catch handler performs a compensating
balance update or assumes funds are still locked after a lost response.

## Installation and provisioning

1. Use a fresh PostgreSQL 15+ database or Supabase project. Apply
   `sql/001_engine.sql` as the migration owner. This fresh-install script refuses
   to overwrite an existing schema. Supabase provides the `anon`,
   `authenticated`, and `service_role` roles; create those roles first on plain
   PostgreSQL. Do not apply `002` or `003` as schema migrations.
2. Keep `race_private` **out of the Data API exposed schemas**. Ensure `public`
   is an exposed RPC schema. The public wrappers use SECURITY INVOKER; only
   `service_role` may execute them. Private SECURITY DEFINER implementations
   have fixed `search_path`, qualified object references and explicit grants.
   Direct table DML is denied even to `service_role`. RLS is enabled on every
   private table and no browser access policies are defined.
3. Provision a tenant and telemetry provider, and map registered authenticated
   identities to tenant-scoped wallet IDs, as shown below. `sc_enabled` defaults
   to false; enabling it is an explicit tenant configuration choice.
4. Establish opening/promotional balances through `credit_wallet` using a
   durable external reference for each authorized grant. Never seed balances
   through direct UPDATEs, because that bypasses their journal history.
5. Copy `.env.example` to `.env`, enter server-only Supabase credentials, and
   set the JSON provider key registry. Generate a signing key with
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
   Store real keys in a secret manager; `.env` is ignored by git.
6. Run `npm ci`, then `node --env-file=.env src/server.js`. Schedule
   `node --env-file=.env src/sweep.js` at least once per minute. Both can run
   with multiple replicas; the database serializes competing completions.

Provisioning example, run only by an authorized operations identity:

```sql
BEGIN;
INSERT INTO race_private.tenants(id,name)
VALUES ('11111111-1111-4111-8111-111111111111','Example tenant');
INSERT INTO race_private.providers(tenant_id,id)
VALUES ('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222');
INSERT INTO race_private.users(tenant_id,id,auth_user_id) VALUES
('11111111-1111-4111-8111-111111111111',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '66666666-6666-4666-8666-666666666666'),
('11111111-1111-4111-8111-111111111111',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 '77777777-7777-4777-8777-777777777777');
SELECT public.credit_wallet(
 '11111111-1111-4111-8111-111111111111',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'GC', 100.00, 'opening:challenger:GC');
SELECT public.credit_wallet(
 '11111111-1111-4111-8111-111111111111',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'GC', 100.00, 'opening:opponent:GC');
COMMIT;
```

`createAndLockChallenge()` is a backend integration function. Before calling
it, the host application must authenticate each participant, verify tenant
membership and obtain both participants' acceptance of the exact challenge
terms. Persist their acceptance and bind the approved provider/session UUIDs.
The RPC's service-role authorization establishes a trusted backend boundary;
it does not itself collect participant consent. Do not expose service-role
credentials or forward arbitrary browser-supplied RPC arguments.

```js
import { createAdminClient, createAndLockChallenge } from './src/settlement.js';

const result = await createAndLockChallenge(createAdminClient(), {
  p_tenant_id: '11111111-1111-4111-8111-111111111111',
  p_request_id: '44444444-4444-4444-8444-444444444444',
  p_challenger_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  p_opponent_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  p_token_type: 'GC',
  p_entry_fee: '10.00',
  p_provider_id: '22222222-2222-4222-8222-222222222222',
  p_session_id: '33333333-3333-4333-8333-333333333333',
  // Persist this value with the request; do not recompute it when retrying.
  p_telemetry_deadline: 'REPLACE_WITH_AN_EXACT_FUTURE_ISO_TIMESTAMP'
});
```

## Telemetry protocol

The example payload is `telemetry.example.json`. Final packets include exactly
the two registered competitors, their lap arrays, the challenge/session IDs,
a stable event UUID, `final: true`, and `race_status` equal to `completed` or
`network_drop`. The payload has no tenant field: tenant and provider are derived
from the server's authenticated key configuration. The database rechecks the
tenant, provider, session and participant tuple under the challenge lock and
recomputes the decision from the two supplied minima.

`lap_time_seconds` may be a JSON number or plain decimal string with at most six
fractional digits and absolute value at most 86400. Decimal strings are preferred.
For clean laps, the schema rejects NaN, infinity, booleans and null times. It
also rejects unknown fields, duplicate drivers, unknown drivers and nonfinal
packets. Dirty laps are discarded regardless of whether their time is absent
or malformed. Zero/negative clean laps are also discarded. Minimum positive clean lap selection uses integer BigInt
microseconds. Empty arrays are legitimate no-lap results. Lap array order has
no bearing on the outcome.

| Terminal race result | Atomic action |
|---|---|
| Both drivers have clean positive laps with distinct minimums | Faster driver receives 90% of gross pool; treasury receives 10% |
| Exactly one driver has a clean positive lap | That driver wins with the same payout/rake policy |
| Both drivers have no valid lap | Return each full entry fee; no rake |
| Minimum times tie at microsecond precision | Return each full entry fee; no rake |
| Authenticated provider reports `network_drop` | Return each full entry fee; no rake, even if laps exist |
| No final event arrives before the persisted deadline | Timeout worker returns each full entry fee; no rake |
| Payload binding or signature is invalid | Reject; no balance mutation |
| Database/transport fails | Retry identical event; no separate refund transaction |

The telemetry provider is the authority for `is_clean` and race-network-drop
classification. HMAC authenticates its report; it cannot independently prove
track physics or prevent a compromised provider from signing false data.
Participants must not control provider signing keys. Provider-side anti-cheat
and the recording of final session telemetry belong at that trust boundary.

### Signature and replay contract

Headers:

```text
Content-Type: application/json
X-Telemetry-Key-Id: provider-key-1
X-Telemetry-Timestamp: <10-digit UNIX seconds>
X-Telemetry-Signature: <lowercase hex HMAC-SHA256>
```

The HMAC input is the following UTF-8 prefix followed by the exact raw JSON
request bytes, with a newline after the timestamp:

```text
POST\n/api/v1/telemetry/settle\n<key-id>\n<timestamp>\n<raw-body-bytes>
```

Verification uses constant-time comparison, a five-minute timestamp window,
and a 1 MiB uncompressed body limit. Compressed request bodies are rejected.
The schema bounds each driver's array at 10,000 laps. No body parser runs before
signature verification. Keep server/provider clocks synchronized.

An accepted event's `(tenant, provider, event_id)` and SHA-256 body commitment
are retained transactionally. The same identity and bytes return the stored
result; a changed commitment conflicts. A different final event for an already
completed challenge also conflicts. On a delayed retry, sign the same bytes
with a fresh timestamp; do not regenerate event IDs or reserialize the body.
Retain original telemetry bytes at the provider for evidence matching their
stored hash. Authentication timestamp and HMAC are excluded from that body hash.

Two key IDs can map to one provider for controlled key rotation. Update the
server registry atomically and disable the old key after the producer has
switched. The provider's database `enabled` flag blocks further signed
settlements when disabled. Timeout refunds remain possible with a provider
disabled so availability cannot strand already-funded escrow.

### Responses

| HTTP status | Meaning |
|---|---|
| 200 | Committed final result, including `duplicate` for an identical replay |
| 400 / 422 | Invalid JSON, RPC input, or telemetry structure |
| 401 | Missing/invalid signature or expired timestamp |
| 403 | Disabled or unauthorized provider/currency operation |
| 404 | No challenge with the authenticated binding |
| 409 | Conflicting event, completed/disputed challenge, or passed deadline |
| 413 / 415 | Oversized body or unsupported media/encoding |
| 503 | Retry same event; commit status may be unknown; `Retry-After: 2` |

POST RPC retries handle transport failures, serialization conflicts, deadlocks,
lock timeouts and transient server errors. There are three attempts with bounded
backoff and a 12-second per-attempt client timeout. Business rejections do not
retry. Arguments are snapshotted before the first await so a caller's later
mutations cannot change the event ID or terms during a retry. Invalid retry
configuration is rejected before issuing any RPC. The producer must durably queue final events before sending, retain them
until a 200 acknowledgement, and retry 503/transport failures. The endpoint
returns 200 only after the RPC resolves successfully; it never acknowledges an
uncommitted in-memory job as settled.

The persisted telemetry deadline is enforced by the database clock. Include
the intended race duration and final-event delivery grace when setting it;
the maximum creation horizon is 24 hours. The timeout scheduler must run and
have sufficient capacity to drain overdue sessions. Late final events cannot
override an expired session or undo a committed refund. Refunds use status
`Settled` with an explicit refund resolution, matching the requested four-value
status enum. `Disputed` challenges remain locked for an authorized dispute
workflow; automation never releases a disputed escrow.

## Operations and verification

Place the API behind TLS and a gateway with shared rate limits, ingress access
controls, bounded request timeouts and DDoS protections. Do not expose the
signing route as a mobile client write interface. Supabase service credentials
and provider secrets remain server-only. Route user-facing balance/read flows
through separately authenticated, tenant-scoped application APIs.

Use PostgreSQL `fsync=on`, `synchronous_commit=on`, appropriate durable storage,
backups/PITR and a tested restore procedure. Configure the actual RPC transaction
timeout in PostgREST (`db-hoisted-tx-settings` includes `statement_timeout`) or
the backend role; a private function's SET alone is not a substitute for a
request-level statement timer. SQL lock timeouts bound waits. HTTP aborts do
not constitute a database cancellation guarantee.

Monitor final-event error rates, idempotency conflicts, provider authentication
failures, overdue escrow count/age, database lock waits, reconciliation drift
and scheduler failures. Logs include request/tenant/provider/challenge/event
IDs, outcomes and duration; they exclude secrets, request headers and raw bodies.
A synchronous or asynchronous logging failure emits a fixed diagnostic and
cannot change a committed payout's HTTP result or stop a timeout-refund batch.
`/healthz` is liveness, not a database-readiness assertion. Protect operational
telemetry and diagnostic queries according to tenant boundaries.

Run deterministic tests:

```bash
npm ci
npm test
npm audit --omit=dev
```

These tests execute the full DDL/functions in PGlite (PostgreSQL compiled to
WASM), plus real HTTP requests and a signed HTTP-to-SQL integration. They cover
funding, precise rake, GC/SC isolation, zero-fee refunds, tenant/session bindings,
idempotency conflicts, deferred journal constraints, privilege restrictions,
and injected failures after credits but before event persistence. PGlite is
single-session: it does **not** prove concurrent row-lock behavior.

Run the native suite against a **fresh disposable PostgreSQL database** with
independent connections:

```bash
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/racing_test \
RACING_ALLOW_TEST_DATABASE=1 npm run test:concurrency
```

It checks eight-way creation/settlement replay, distinct challenges competing
for insufficient shared funds, reversed participant order, contradictory final
events, timeout-versus-telemetry contention and per-currency conservation.
It also observes native lock waits while a first settlement transaction is
uncommitted, verifies the commit and rollback replay paths, cancels a backend
after attempted credits but before event persistence, and exercises SERIALIZABLE
funding conflicts and simultaneous GC/SC funding.
It refuses a database with an existing `race_private` installation. The test
database owner must be able to create missing Supabase-style roles. It leaves
test data for inspection; dispose of the test database afterward.

### Native tests in CI and containers

Use this directory as the repository root. `.github/workflows/verify.yml`
runs on pushes and pull requests with fresh PostgreSQL 15 and 17 service
containers. It runs deterministic tests, the native suite, and the production
dependency audit, and preserves JUnit reports. Actions are pinned to verified
commit SHAs and checkout does not persist credentials. Configure the resulting
checks as required in repository branch protection before allowing releases.
The workflow passed on PostgreSQL 15 and 17 for the initial deployment commit
`416f65209e1245bb13fb0c5dad633a837f556075` on 2026-10-05, including native
independent-session concurrency tests and the production dependency audit.

For a disposable local native run on a Docker-enabled machine:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -f compose.test.yaml down --volumes
```

The test database uses synthetic credentials, tmpfs storage and no published
host port. Production credentials are not required. `test:all` deliberately
fails if the native database configuration is missing; it never silently skips
the concurrency suite.

The production image runs the HTTP service as the unprivileged `node` user:

```bash
docker build --target production -t racing-escrow:1.1.0 .
docker run --rm --env-file .env -p 3000:3000 racing-escrow:1.1.0
```

Schedule the refund worker separately with the same server configuration and
image using `node src/sweep.js`. Container health checks test HTTP liveness,
not financial readiness or database durability. The image build accepts a
`NODE_IMAGE` argument so an operations pipeline can pin its approved image
digest. Production storage remains in the configured Supabase/PostgreSQL
ledger; the disposable test compose file is not its deployment topology.

The deployed runtime provides the requested ledger integration and telemetry
API plus a mobile-friendly service status page. Cash custody, redemption,
participant onboarding and consent collection require separate integrations.
The status page does not enable race entry or spending.

## Primary implementation references

- PostgreSQL row locks: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgREST transaction boundaries and rollback: https://docs.postgrest.org/en/v14/references/transactions.html
- Supabase JavaScript RPC: https://supabase.com/docs/reference/javascript/rpc
- Supabase changelog checked during implementation: https://supabase.com/changelog.md

The current changelog includes Data API exposure changes. Configure exposed
schemas and explicit RPC EXECUTE grants rather than depending on automatic
table exposure.
