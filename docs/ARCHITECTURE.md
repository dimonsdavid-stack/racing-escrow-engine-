# External sim P2P architecture

The platform coordinates two players' fixed challenge terms around a race in an external simulator. It supports an own-driver duel and an opposing two-driver selection for a registered event. It does not operate a browser race, set sportsbook odds, or accept an unrestricted post-race customer claim as a financial result.

## Financial invariants

Wallets have independent `numeric(24,6)` GC and SC projections. A challenge reserves the **gross** two-entry pool and records a 10% rake reservation; the reservation stays in escrow until a winner is confirmed. Funding posts two wallet debits against an escrow credit. Settlement debits escrow, credits the winner 90% of gross, and credits treasury 10%. Refunds debit escrow and return each full entry, charging zero rake. Deferred journal constraints require net-zero entries in the same transaction. Journal and source receipt rows are append-only.

`create_and_lock_challenge`, `sim_accept`, `sim_commit_result`, `fulfill_coin_purchase`, and deadline refund RPCs run as single PostgREST transactions. `BEGIN … COMMIT` surrounds each installation migration; a PostgreSQL function cannot independently commit its caller's transaction. Calling `.update()` on two wallets is never treated as a transaction.

Wallet rows are locked in UUID order using `FOR NO KEY UPDATE`, avoiding reversed player lock acquisition and FK key-share conflicts. Challenge/offer rows serialize lifecycle changes. Request IDs and immutable parameter comparisons make retries idempotent. Stripe intent receipts and source evidence prevent duplicate credits. A database or network interruption never triggers a compensating payout or a transport-error refund. A lost HTTP response can mean the database committed; retry the **same** immutable request and check the durable receipt.

## Tenant and customer isolation

All private relationships include `tenant_id`. Private tables have RLS and no direct DML grants for customer or service application roles. Public invoker wrappers and narrowly granted security-definer RPCs expose controlled behavior; fixed `search_path=pg_catalog` prevents search-path substitution. Customer functions derive the actor through `auth.uid()`, verify the confirmed non-anonymous account, and require a live `auth.sessions` session from the trusted JWT. Service integrations never accept a browser-provided actor ID. Separate HMAC keyrings bind providers and Discord brokers to a tenant. Neither the service-role key nor OAuth tokens reach the browser.

Sign-in returns a wallet only after explicit profile enrollment. SC is disabled by default at both tenant and account boundaries. Participation pauses and payment-review holds block new entries. Identity changes take the same wallet lock as funding and are prohibited while that wallet has active escrow.

## Scheduled events and acceptance

Trusted providers register immutable event IDs, simulator session references, registered external driver selections, track, rule, future start, funding cutoff, and validation deadline. Players cannot register events through the customer API. Acceptance locks the offer, checks the invited opponent, rechecks the schedule and eligibility, resolves verified simulator identities, snapshots both selections, and funds both wallets in one transaction. Pending invitations hold no funds and can be cancelled by their creator.

Multiple P2P contracts may reference the same external race. Each challenge has an independent internal session UUID and journal. Settlement rechecks the provider, external session, track, actual race start after funding, and source receipt. A historical session cannot be substituted for a newly funded event.

## Provider validation

The preferred iRacing path uses the official OAuth authorization endpoint, `iracing.auth` scope, PKCE, bearer Data API requests, and an authorized operator account. Access tokens are encrypted using AES-256-GCM. Refresh is a durable exclusive lease because iRacing refresh tokens are single-use. A lost external refresh response causes reconnection instead of blindly replaying that token. Token persistence uses a version/lease CAS.

Data endpoint requests are fixed to `members-ng.iracing.com`. Downloads and chunk URLs must match an **exact configured hostname allowlist**, HTTPS, no embedded credentials, no custom ports, no redirects, and bounded body/chunk sizes. Access headers are never forwarded to downloaded S3 resources. Do not broadly allow arbitrary URL hosts supplied by a webhook.

The adapter's live authenticated Data API response schemas still require verification using the operator's actual provider access. It expects `results/get`, `results/lap_data`, `chunk_info`, integer lap ticks, and explicit `lap_events`; unexpected/missing validity is a schema failure that leaves escrow locked, not evidence that every lap was clean. SessionFlags are not used as clean-lap proof. Provider fixtures test this contract; fixtures are not live-provider certification.

ACC results come from a trusted dedicated server host, not a player's browser. `normalizeACC` maps car/driver IDs to Steam identities, requires `isValidForBest` and positive integer milliseconds, and rejects ambiguous team-driver laps. The host must supply the actual session start from its session logs and bind `metaData` to the registered session. Missing logs remain pending until valid evidence or deadline refund.

Signed normalized reports contain both selected drivers and complete final evidence. Dirty/nonpositive laps are ignored; integer microseconds preserve comparison accuracy. Ties and both drivers lacking eligible results refund. An explicit **signed simulator-session disconnect** refunds. An iRacing HTTP error, missing credentials, parser incompatibility, or unavailable database retries the job; it does not prove the race disconnected. Deadline refunds provide the eventual zero-fee resolution.

## Commerce

The catalog is server-owned and orders snapshot amounts and coin grants before checkout. Stripe checkout calls use a stable order idempotency key. The webhook consumes raw bytes and validates Stripe's signature before JSON parsing. It retrieves the session from Stripe and checks `paid`, mode, currency, exact amount, order ID, and payment intent. One SQL RPC inserts the receipt, credits both currencies through journal entries, and marks the order paid. An SC posting failure rolls back GC posting too.

Refund/chargeback events create durable payment-review cases and hold new account participation. They do not create negative coin balances or erase previous receipts. Out-of-order cases are reapplied when payment fulfillment arrives. Case reconciliation and approved merchant refund procedures are operator responsibilities; cash redemption is not implemented or activated by this release.

Stripe integration is conditional. Stripe's published restricted-business rules include sweepstakes and skill competitions with valuable prizes. `COMMERCE_APPROVED` is an operator gate, not evidence that Stripe approved a business. Do not activate checkout based only on labeling purchased entries “free promotional coins.”

## Runtime and UI

Next.js produces the responsive dashboard as a static export. Express serves its compiled assets and API from one origin on Vercel or standalone Node. Build-generated inline scripts are allowed through exact SHA-256 CSP hashes; no broad inline-script permission is used. Server data comes from verified customer RPCs, refreshes periodically while visible, and never writes balances locally. Monetary display uses decimal strings and bigint calculations, retaining nonzero fractional precision.

Durable job leases use `FOR UPDATE SKIP LOCKED`; interrupted leases expire. Run `npm run worker` in a persistent container. Run `npm run discord` separately; Vercel request functions cannot maintain a permanent Discord Gateway connection. Customer callback, worker, provider ingress, and checkout all fail closed without required configuration.

## Operational limits

This release has not been load-tested with 200,000 simultaneous or registered platform users. The user's cited iRacing population is an external audience, not a verified platform metric. No absolute availability guarantee follows from ACID transactions. Transactional guarantees rely on PostgreSQL's durability configuration, correct operational credentials, and trusted source integrations. Region eligibility, official sweepstakes rules, provider commercial authorization, dispute operations, and redemption require operator activation and verification beyond source deployment.

## Institutional enforcement

Migration 4 renames the isolated currency enum to `currency_type`, adds explicit `Refunded` states, normalized promotion/compliance/risk/AME evidence, exact prize and withheld-rake aliases, admission counters, and tamper-evident journal seals. See `COMPLIANCE.md` for the precise trust and activation boundaries. The gross escrow remains intact until resolution; net `prize_pool` is gross minus the 10% rake reserve. Reserving a rake does not recognize platform revenue before a winning settlement. This is necessary to refund 100% with zero fee.

Wallet locks use canonical `FOR NO KEY UPDATE` ordering because these balance mutations do not alter keys. This provides exclusive balance writes while avoiding foreign-key key-share deadlocks observed with indiscriminate `FOR UPDATE`. Challenges, event terms, evidence and audit heads retain their appropriate locks. RPCs execute within the caller's single PostgreSQL transaction; PL/pgSQL functions cannot open autonomous `BEGIN … COMMIT` transactions. The fresh-install DDL has explicit transaction boundaries. Deadlock/serialization/network retries keep the original mutation identifiers.

The requested public compatibility function names do not expose unrestricted winner/amount choices: acceptance derives the invited participant and source-bound settlement cross-checks stored evidence, token and net amount. Security-definer implementations live in the isolated schema; version 4 public wrappers are security invoker with explicit role grants. Unrelated tenant and public functions retain their own grants.
