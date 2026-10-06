# API contracts

All customer calls require `Authorization: Bearer <verified Supabase session access token>`. Actors and tenant are resolved by the server and SQL session, never accepted as arbitrary body claims. JSON schemas reject extra fields. Currency amounts are decimal strings.

| Method / path | Body / behavior |
|---|---|
| GET `/healthz` | Process liveness only |
| GET `/api/v1/status` | Version and configuration state; does not assert database connectivity |
| GET `/api/v1/app/config` | Public publishable config and integration activation flags |
| POST `/api/v1/app/enroll` | `{ "handle":"Driver_1", "accept_terms":true }` |
| GET `/api/v1/app/me` | Exact balance strings, locked entries, journal history, identities and external contracts |
| GET `/api/v1/app/lobby` | Registered upcoming external events and eligible open challenges |
| POST `/api/v1/app/offers` | `{ "request_id":"uuid", "event_id":"uuid", "mode":"driver_duel", "token_type":"GC", "entry_fee":"10.00", "selection":null, "target_id":null }` |
| POST `/api/v1/app/accept` | `{ "offer_id":"uuid", "accept_terms":true, "selection":null }`; event match requires a distinct registered selection |
| POST `/api/v1/app/cancel` | `{ "offer_id":"uuid" }`; creator only, before acceptance |
| POST `/api/v1/app/request-result` | `{ "challenge_id":"uuid" }`; queues validation, takes no winner/laps |
| POST `/api/v1/app/daily` | `{}`; journaled GC grant, once per UTC day |
| POST `/api/v1/app/pause` | `{ "hours":24 }`; permitted values 1, 24, 168 |
| POST `/api/v1/app/identity/iracing` | `{}`; PKCE OAuth redirect, state cookie |
| POST `/api/v1/app/identity/steam` | `{}`; Steam OpenID redirect, state cookie |
| POST `/api/v1/app/identity/discord` | `{}`; verified Discord identity from Supabase provider identities |
| GET `/api/v1/identity/iracing/callback` | Registered provider redirect; state-bound one-use callback |
| GET `/api/v1/identity/steam/callback` | Steam signed OpenID assertion, server-side verification |
| GET `/api/v1/app/catalog` | Approved active packages from the tenant's server catalog |
| POST `/api/v1/app/checkout` | `{ "order_id":"uuid", "package_id":"pack_bronze_10" }` |
| POST `/api/v1/stripe/create-checkout` | Authenticated alias for the checkout route above |
| POST `/api/v1/stripe/webhook` | Raw body and `Stripe-Signature`; session verified directly with Stripe |
| GET `/api/v1/operations/refund-expired` | `Authorization: Bearer <CRON_SECRET>`; bounded batch of atomic refunds |
| POST `/api/v1/providers/events` | HMAC signed trusted league/provider event registration |
| POST `/api/v1/providers/results` | HMAC signed complete normalized provider result |
| POST `/api/v1/telemetry/settle` | Same normalized provider result contract; legacy reports cannot settle new simulator contracts |
| POST `/api/v1/challenges/initiate` | Separate Discord broker HMAC; verified Discord actor/opponent, future event, immutable request UUID |
| POST `/api/v1/challenges/accept` | Separate broker HMAC; server rechecks the invited opponent |

## Provider authentication

`X-Telemetry-Key-Id`, `X-Telemetry-Timestamp` (10-digit epoch seconds), and `X-Telemetry-Signature` (lowercase hex HMAC-SHA256) authenticate exact uncompressed UTF-8 JSON bytes. The signed message is `POST\n<exact path>\n<key ID>\n<timestamp>\n<body bytes>`. Signature age is limited to five minutes. Never reserialize a body after signing. Provider identities come from `TELEMETRY_KEYS_JSON`. Discord uses `DISCORD_BROKER_KEYS_JSON`, separately provisioned. Refresh the timestamp/signature on retry; preserve the immutable body/source ID.

Use `signBody` in `src/signature.js`. The default path is `/api/v1/telemetry/settle`; supply the fifth argument for other routes. Webhook HTTP authentication and database event/source uniqueness are separate replay defenses.

## Event registration fields

`event_id`, `game` (`iracing` or `acc`), `external_session_id`, `title`, `track_name`, ISO-offset `starts_at`, `funding_closes_at`, `deadline`, `rule` (`fastest_clean_lap` or `finish_position`), and `entrants` (two to 200 distinct external ID strings). A provider signs these exact immutable terms before funding opens. Event deadline must fit within the engine's 24-hour challenge lifetime. No customer-facing endpoint can register a fake event.

## Normalized final report

```json
{
  "challenge_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "event_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "source_id": "iracing:876:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "external_session_id": "876",
  "track_name": "Spa",
  "actual_start": "2026-10-06T16:00:00Z",
  "final": true,
  "race_status": "completed",
  "drivers": [
    {"external_id":"123","finish_position":1,"laps":[{"is_clean":true,"lap_time_seconds":"60.000001"},{"is_clean":false,"lap_time_seconds":"1"}]},
    {"external_id":"456","finish_position":2,"laps":[{"is_clean":true,"lap_time_seconds":"62.000001"}]}
  ]
}
```

This is a documented wire example, not a registered live race. Actual challenge/event/source bindings come from the database. A report must include both selected drivers when completed; empty lap arrays are explicit no-valid-lap evidence. `race_status:"network_drop"` is a trusted simulator-session failure assertion, never a customer claim or API transport failure. Finish positions are positive 1-based overall positions. They are displayed as positions, not fictitious lap times.

Success returns the durable SQL receipt. A 503 means the request was not confirmed; retry the same identity/body or inspect the confirmed state. Do not submit a new payment/order/event identity merely because a response was lost. HTTP 403/409 requires rechecking eligibility and immutable bindings, not automatic resubmission with different terms.

`POST /api/v1/providers/contracts` accepts signed `{ "external_session_id":"registered-session", "after":null }` and returns at most 100 active provider-bound contexts in UUID order. Continue using the last `challenge_id` as `after`. This is a trusted-host integration route; it provides no wallet balance data and accepts no browser session. The ACC bridge uses it to settle multiple independent P2P contracts on the same external race.

## Institutional routes

| Method / path | Contract |
|---|---|
| GET `/api/v1/app/program` | Public published current rules, or `{ "program":null }` |
| GET `/api/v1/app/compliance` | Own current eligibility, consent, remaining quota and recent AME receipts |
| GET `/api/v1/app/audit` | Own confirmed wallet journal sequence/hash checkpoint |
| POST `/api/v1/app/compliance/consent` | `{ "program_id":"uuid", "accept_terms":true }` |
| POST `/api/v1/app/ame` | `{ "request_id":"uuid", "program_id":"uuid" }`; stable retry, no checkout dependency |
| POST `/api/v1/compliance/receipts` | Trusted signed evidence; exact fields in `COMPLIANCE.md` |
| POST `/api/v1/compliance/programs/publish` | Operator signed immutable program; full Zod schema in `src/compliance.js` |
| POST `/api/v1/compliance/programs/activate` | `{ "change_id":"uuid", "program_id":"uuid", "enabled":true, "authorization_reference":"record reference" }`; operator only |
| POST `/api/v1/compliance/reviews/resolve` | `{ "case_id":"uuid", "reason":"recorded review reason" }`; operator only |

Signed routes use the existing raw-body HMAC protocol, including exact route path. Verification and operator keys are separate from telemetry and Discord keys. Retry the original immutable body and identifier after an unknown commit. REST admission failures return 429 with `Retry-After`; SQL financial guards also protect direct authenticated RPC calls.

Future event registration adds decimal-string `min_lap_seconds` and `max_lap_seconds` (defaults 1 and 3600). The operator must choose plausible bounds for the actual event. Normalized telemetry laps can additionally carry an integer `flags`; any nonzero value is disregarded. Provider-specific session flags are not automatically lap-validity flags.

The compatibility RPC `execute_p2p_escrow(p_challenge_id UUID)` resolves the authenticated invited opponent and tenant rather than accepting a user ID. `commit_challenge_settlement(p_challenge_id UUID,p_winner_id UUID,p_payout_amount NUMERIC,p_token_type TEXT,p_subsession TEXT)` is service-only and checks the supplied terms against authoritative stored evidence. Payout cannot be chosen by a customer or caller-provided amount. Refunds now explicitly use challenge state `Refunded`.

## v4.2 cash and hosted verification

See [REDEMPTION.md](REDEMPTION.md) for the exact cash, bank, KYC and postal receipt contracts. Customer redemption bodies contain only an idempotent request UUID and an exact decimal SC amount. The authenticated account determines ownership; raw bank details and body-supplied owner IDs are rejected. Provider confirmation, not a successful HTTP request, determines paid status.
