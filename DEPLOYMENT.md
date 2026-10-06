# Deployment and activation

## Source and web deployment

Repository: https://github.com/dimonsdavid-stack/racing-escrow-engine-

Production web URL: https://racing-escrow-engine.vercel.app/

The Vercel project uses Node 24 and Express auto-detection. `npm run build` generates `supabase/schema.sql` and the Next.js static export in `frontend/out`. `server.js` exports the runtime Express app; Vercel includes `frontend/out/**`. Keep Vercel's framework setting **Express**, because the API runtime serves the exported Next UI. This is not a Next SSR project. Exact build-generated CSP script hashes are computed by Express; do not override them with a static header that blocks hydration.

GitHub Actions must pass before promotion to main. It builds the UI, runs deterministic HTTP/SQL tests, native independent-session transactions on PostgreSQL 15 and 17, browser stories on desktop/Pixel, and production dependency audit. Browser screenshots are retained in the run artifacts. Builds require no live secrets. Missing integration configuration leaves a navigable dashboard and explicit unavailable API responses.

## Supabase

Use a dedicated live project. Do not reuse an unrelated paused database. Apply `supabase/schema.sql` **only on a fresh installation** through the SQL Editor as postgres. For an existing engine, apply only unapplied files under `supabase/migrations`, preserving existing journals. Migration blocks roll back on failure. Migration order is core engine, customer auth, then external sim/commerce.

Create tenant and provider records as the migration owner. Generate UUIDs once and keep them stable. Enable `customer_signup_enabled` only after verified sign-in is configured. The schema intentionally defaults SC and commerce to disabled. Configure Supabase's site URL and allowlisted redirect to the exact application origin. Enable Discord with the operator's own registered Discord OAuth application; use its callback URL supplied by Supabase. Enable email confirmation and appropriate rate limits.

There are no direct frontend table grants. Private tables must remain outside exposed REST schemas. Customer SQL functions require live auth sessions and confirmed accounts. Run Supabase security/performance advisors after migration. Take managed backups, verify restore procedures, and configure production connection/transaction limits before scaling.

Catalog amounts are configured once in the database, not repeated differently in frontend code. An approved initial catalog may use `pack_bronze_10` at 1000 cents with 10000 GC, `pack_silver_20` at **2000** cents with 25000 GC, and `pack_gold_50` at 5000 cents with 60000 GC. Promotional SC grants (10/22/55) require the operator's approved program and per-account eligibility. Set packages and tenant commerce enabled only after merchant permission and actual live verification. Merely supplying these values does not activate sales.

## Server secrets

Populate the names in `.env.production.example` in the hosting secret manager. No filled `.env.production` is tracked. `SUPABASE_PUBLISHABLE_KEY` is the public publishable/anon key, not the service role. Set `SUPABASE_SERVICE_ROLE_KEY`, tenant UUID, origin, long random cron secret, separate provider/broker keyrings, and a random 32-byte base64 OAuth encryption key. Each provider/broker key must contain at least 32 random bytes. Rotate keys with a brief overlap of distinct key IDs mapped to the same identity. Never copy the demonstration strings in a prompt as operational secrets.

## iRacing

Register an OAuth client with iRacing and an exact redirect `https://racing-escrow-engine.vercel.app/api/v1/identity/iracing/callback`. Supply client ID, issued client secret if applicable, and the exact download hostnames returned by approved Data API usage. Connect an authorized operator account through the UI and configure its Supabase auth user ID for the worker. OAuth uses `iracing.auth`, PKCE, and masked client secrets; it does not log into the homepage using a username/password scraper.

Verify real authenticated `member/info`, `results/get`, and `results/lap_data` payloads against the adapter before enabling funding for that provider. Official authenticated Data API schemas may differ; unrecognized responses must remain pending, not silently declare clean laps. Compare fixture normalization with the provider's actual lap validity semantics. Confirm commercial permission and user consent for the proposed access pattern. Register scheduled events and their driver IDs through the signed provider route, never by allowing a player to type a completed subsession ID.

## ACC

An approved dedicated server host must produce result files plus session start logs. Verify Steam ownership through the UI. Normalize the real ACC result file with `normalizeACC`, providing a source receipt ID, registered event/session metadata, and actual session start. Use dedicated-server `isValidForBest`, playerId/driverIndex, and integer lap milliseconds. Do not interpret arbitrary flags as proof of clean driving. Send a signed normalized report from the trusted host using its tenant/provider key. Teams without unambiguous per-lap driver evidence must fail closed.

## Payments

Stripe's published restrictions include sweepstakes and skill competitions with prizes. This release supplies a genuine Checkout/webhook integration, but does not assert merchant approval. Obtain explicit authorization for the actual business before setting `COMMERCE_APPROVED=true`. An approved alternative payment provider requires its own integration and validation; no fake processing fallback is provided.

Register `/api/v1/stripe/webhook` with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`. Store its webhook signing secret only on the server. Verify a paid test session credits exactly once, replay duplicate delivery, and verify amount/currency mismatch rejection. Test incomplete/delayed payment handling. Exercise refunds/chargebacks and reconcile durable payment-review cases. Cash redemption and official SC program operations remain outside this release and must not be advertised as active.

## Persistent workers and Discord

Build the supplied Docker image. Run the web process `node src/server.js`, results/refund process `node src/worker.js`, and Discord process `node discord/bot.js` as **separate services** with independent operational limits. Vercel hosts the request API and web UI; it cannot run a permanent Discord Gateway bot.

Register commands intentionally with `npm run discord:register`; normal startup does not repeatedly overwrite global commands. Set bot token, application client ID, exact backend origin, public app origin, and a broker key matching the server's separate broker keyring. Invite the bot using application-command permissions. `/challenge` takes an opponent, decimal-string entry, currency, and registered event UUID. The creator and opponent must connect verified Discord and simulator accounts. The accept component checks the actual interacting user, and SQL checks the targeted wallet again. No funding occurs on invitation alone.

Run at least one result worker continuously. Its durable leases and independent idempotent refunds permit multiple worker replicas. The optional authenticated refund HTTP endpoint processes a bounded batch; schedule it externally as an additional watchdog. Monitor expired active challenge counts, job retries/lease age, OAuth reconnect conditions, failed payment fulfillment, unreviewed chargebacks, and ledger reconciliation results. Do not expose secrets or signed download URLs in logs.

## Validation and release

`npm ci --ignore-scripts`; `npm run build`; `npm test`; browser tests against the built UI. Native tests require a new disposable database:

```sh
DATABASE_URL=postgres://test_owner:test_password@127.0.0.1:5432/racing_test RACING_ALLOW_TEST_DATABASE=1 npm run test:concurrency
```

Never use a production connection for concurrency tests. The suite refuses an installed engine schema. CI tests PostgreSQL 15/17 independent connections, duplicate acceptance, concurrent purchase delivery, source receipt failure rollback, and balanced journals. Source tests cannot certify live OAuth/API permissions, actual payments, production scaling, or legal launch eligibility.

For rollback, restore a prior known-good web deployment while preserving the current database schema and durable receipts. Never roll balances back from a cached client state or drop migration tables to undo a UI release. Confirm clients' version and CSP hydration, API unavailable-state behavior, and scheduled refund processing after promotion.

## Current activation boundary

The web release can be published without secrets. This session does not possess working racing Supabase project credentials, an authorized live iRacing client/operator account, approved merchant credentials, an activated ACC source host, Discord bot credentials, or a persistent worker deployment. These are explicit remaining activation dependencies, not simulated production integrations. Supabase connector discovery currently returns an authorization error; reconnect the intended account before project selection or provisioning.
