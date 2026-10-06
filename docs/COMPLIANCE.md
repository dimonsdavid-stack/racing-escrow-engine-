# Promotion, risk and audit controls

This release implements enforcement and evidence collection. It does not establish a lawful sweepstakes, grant merchant or simulator permission, provide kernel anti-cheat, or implement cash redemption. The operator must commission jurisdiction-specific rules and vendor integrations before SC activation.

## Program publication

A program has an immutable version, sponsor, official HTTPS rules URL and document SHA-256, start/end dates, minimum age, eligible territory codes, exact free SC award, period duration, and maximum requests per period. Publish through `POST /api/v1/compliance/programs/publish`, then activate through `/api/v1/compliance/programs/activate`. Both require the operator keyring, a registered enabled provider, an immutable change UUID, and a recorded authorization reference. The activation is separately logged. Publishing does not enable a tenant's SC or commerce flags. Never generate official rules from a presumed US-wide legal threshold.

The dashboard displays the actual published program. Its free-entry section is reachable before shopping and independently of checkout. A customer reads the current rules, signs in without buying coins, records consent to that exact version, obtains eligibility verification, and submits a free request. A confirmed credit and receipt are shown only after database commit. Inactive programs show an explicit unavailable state. Free-entry limits and schedule are operator terms, not inferred legal requirements.

## Trusted verification contract

`POST /api/v1/compliance/receipts` accepts a signed assertion from a trusted identity, location or risk bridge. It does not call GeoComply or a KYC vendor itself. Supply the real bridge on a separate trusted host; customer browsers cannot issue assertions. The signing key maps to tenant/provider outside the body. Identity assertions contain a stable pseudonymous person key and verified age threshold, without raw identification documents, birth date or coordinates. Use a vendor-issued consistent token transformed with a private per-tenant HMAC key; do not use an unsalted hash of email or date of birth.

The strict body contains `receipt_id`, `auth_user_id`, `purpose`, `decision`, `reason`, `observed_at`, `valid_until`, `subject_key`, `age_threshold`, `territory`, and `proxy_detected`. Optional subject/age/territory fields can be null according to purpose. Purpose is `identity`, `location` or `risk`; decision is `approved`, `denied` or `review`. An approved identity requires subject key and age. An approved location requires an eligible territory and no detected proxy. Assertions cannot be more than 30 seconds in the future or 24 hours old. Maximum identity validity is 90 days, location five minutes and risk 15 minutes. Event funding and free entry recheck the current program and proof expiry inside the wallet transaction. Account reads remain available when evidence expires.

One verified person key binds to one wallet per tenant. Concurrent reuse opens a durable review and does not acquire eligibility. A denied risk assertion also opens a case. An unresolved risk case blocks both GC and SC participation. `/api/v1/compliance/reviews/resolve` requires the separate operator signing role, case UUID and recorded review reason. Resolution does not fabricate fresh identity or location evidence. Denied or expired evidence still requires a new trusted verification.

Authentication also verifies confirmed non-anonymous Supabase users and an extant `auth.sessions` record. Client `user_metadata` never controls permissions. Server admission budgets enforce 60 reads, 20 mutations, five checkout requests and five identity initiations per account/minute. Database guards cap open invitations and funding velocity independently of REST, including authenticated direct RPC use. These are bounded operational defaults, not proof of sybil immunity or certified capacity for 200,000 users.

## Free-entry accounting

`POST /api/v1/app/compliance/consent` records the immutable current program UUID. `POST /api/v1/app/ame` receives only request UUID and program UUID. Wallet and tenant are derived from the live authenticated session. A wallet row lock serializes eligibility and period quotas. Request IDs bind to their original user/program; retrying returns the same receipt. A credit creates a balanced SC issuance journal and an immutable AME receipt in one transaction. A rejection records zero amount and reason. Purchases are neither inspected nor required. No GC is burned to receive the award. Every SC debit and credit stays separate from GC.

A network failure does not imply a rollback: the server may already have committed. Retry the same UUID and immutable body. Do not issue a compensating credit or refund because an HTTP response was lost. This rule also applies to purchase fulfillment and race settlement.

## Tamper-evident journal

Every committed financial journal receives a seal and per-participant hash-chain record. The canonical payload contains tenant, wallet, sequence, journal identity, exact decimal lines, currency and timestamp. PostgreSQL hashes UTF-8 canonical JSONB with SHA-256 and the previous hash. Deferred sealing failure rolls back the journal, wallet projection and challenge together. Historical journals are sealed in a deterministic, migration-locked backfill. New lines cannot be appended to a sealed journal; posted entries and audit records are immutable. Each wallet has its own locked head; there is no global financial audit mutex.

`node scripts/export-audit.js WALLET_UUID OUTPUT_JSON [PREVIOUS_EXPORT_JSON]` exports and verifies a fixed head, paginates records, checks continuity/bindings and balances, and can continue from a previously trusted checkpoint. Store checkpoints and exports in independently controlled immutable storage on an operator schedule. This repository does not provision that storage or scheduler. A database owner can rewrite both data and local hashes; an unanchored chain cannot prove resistance to a privileged rewrite. Protect database ownership, backups, and external checkpoints independently.

## Private balance invalidation

The migration installs private Realtime authorization if the platform Realtime schema exists. A topic is `gridstake-wallet:TENANT_UUID:AUTH_USER_UUID`. Receive authorization checks the actual session and wallet. A restrictive policy prevents broader existing permissive policies from opening these prefixed topics. Clients cannot publish to them. The message contains only `{ "refresh": true }`, so the browser fetches confirmed balances through the session-checked REST API rather than trusting an event balance. PostgreSQL sends it transactionally; aborted changes publish no committed event.

Disable public Realtime channel access and configure authenticated private channels before setting `REALTIME_ENABLED=true`. The setting is off by default. The dashboard debounces invalidations and retains bounded polling fallback. Realtime policy caches can remain valid until token refresh; the message contains no financial or personal data, and the REST refresh checks revocation independently.

## Race integrity boundary

Only previously registered future external events can be funded. Terms snapshot event/session, track, entrants, selected drivers, currency and fee. Official iRacing OAuth Data API retrieval and allowlisted HTTPS result downloads stay on the worker. ACC reports come from a trusted dedicated-server bridge. HMAC covers method, exact path, key ID, timestamp and raw bytes. Keys are separated for telemetry, Discord, verification and operator actions. A reused signing secret disables the signing rings at startup.

Clean-lap processing rejects dirty laps, nonzero optional lap flags, nonpositive times, and values outside registered minimum/maximum lap bounds. Actual provider lap-validity evidence is distinct from iRacing SessionFlags; flags alone are not proof of collision-free driving. Source/session, actual start, registered track and drivers are validated again before atomic payout. Both dirty, ties and confirmed disconnects receive full zero-fee refunds; provider fetch failures leave escrow locked for retry, with an idempotent deadline watchdog. A missing response is never interpreted as evidence that a driver disconnected. No claim of hardware-level anti-cheat or source API infallibility is made.
