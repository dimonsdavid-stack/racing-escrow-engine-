# Cash ledger and provider integration — v4.2

This release contains real Sumsub and Stripe Connect adapters. It does not fabricate KYC outcomes, transfers, paid payouts or credentials. Provider calls are production HTTPS calls; production refuses Stripe test keys and Sumsub sandbox/test callbacks. Tests substitute transports only inside test files.

## Financial behavior

- `sc_balance` includes both promotional and won SC. `sc_redeemable_balance` includes verified challenge winnings available for redemption. GC never enters the cash pipeline.
- Existing classification is reconstructed from immutable wallet audit order. Funding consumes redeemable SC first and snapshots that portion for each competitor. Win settlement adds the 90% prize to redeemable SC; zero-fee refunds restore the exact original classification.
- `execute_atomic_withdrawal_debit(p_tenant_id,p_request_id,p_amount_sc)` derives the owner from a live verified Supabase session. It locks the wallet, checks current program/identity/location/risk/payment status, verifies current KYC and bank evidence, and atomically posts the debit, liability journal and durable redemption request. No `.update()` balance writes occur from JavaScript.
- The business policy is minimum 50 SC, maximum 10,000 SC per rolling 24 hours, exact cent precision, and 1 eligible SC = 1 USD. The maximum number of concurrent unresolved requests is three. These are implementation policies, not a statement of legal requirements.
- `Reserved → Transferred → PayoutPending → Paid` records a platform-to-owned-Connect-account transfer followed by a bank payout from that connected account. Only an authenticated provider retrieval with matching recipient, amount, currency and immutable metadata can confirm paid status.
- Bank failure leads to `Reversing`. SC is returned only after the original transfer is confirmed fully reversed. Late failure after paid status creates a compensating journal and a negative tax record. Original records remain immutable.
- A provider or database timeout has unknown commit status. Requests retain stable idempotency keys. Existing provider objects are recovered by account, transfer group, time and metadata. Missing proof beyond the conservative 23-hour idempotency window moves the request to `Review`; no fresh transfer or compensating credit is invented. Review records retain the original funds and provider references for operator reconciliation. A signed operator can wake the same request for provider recovery; this never resets the idempotency window, changes payout instructions or credits money without proof.
- Leases use `FOR UPDATE SKIP LOCKED`; crashed workers are recoverable. Per-wallet financial journals are balanced and included in the existing SHA-256 audit chain, including provider-confirmed liability-only movements.

## Customer endpoints

All customer calls require a confirmed Supabase user and active database session. No owner UUID or raw bank numbers are accepted in redemption bodies.

| Method | Path | Request |
|---|---|---|
| GET | `/api/v1/app/redemptions` | Own classification, verification status and recent requests |
| POST | `/api/v1/app/kyc/start` | `{}`; returns a short-lived hosted Sumsub verification link |
| POST | `/api/v1/app/bank/connect` | `{}`; returns a hosted Stripe Connect onboarding link |
| POST | `/api/v1/wallet/redeem` or `/api/v1/app/redeem` | `{"request_id":"UUID","amount_sc":"50.00"}`; returns 202 after database reservation |
| POST | `/api/v1/kyc/webhook` | Raw Sumsub payload, SHA-256/512 HMAC headers; current provider state is retrieved before updating KYC |
| POST | `/api/v1/compliance/redemptions/reconcile` | Signed operator request ID, receipt UUID and review reason; wakes reconciliation without changing amounts, provider references or original attempt timestamps |
| POST | `/api/v1/compliance/ame/postal` | Signed operator receipt containing receipt UUID, auth user UUID, program UUID, received timestamp, document digest and authorization reference |

A hosted-page return does not approve identity or a bank payout. The UI persists the request ID and amount in owner-scoped session storage before submitting and preserves them across reload/retry. It changes displayed balances only after a confirmed server refresh.

## Real account configuration

Sumsub: configure a **Production individual** level with the actual required government ID, proof-of-address and risk checks. Set `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`, `SUMSUB_LEVEL_NAME`, `SUMSUB_WEBHOOK_SECRET` and the exact returned Sumsub hosted link domain in `SUMSUB_WEBSDK_HOST`. Register the HMAC webhook at `APP_ORIGIN/api/v1/kyc/webhook`. The adapter reads current review state, not the callback's claimed GREEN decision. The separate trusted identity/location/risk receipts remain authoritative for age, territory, person deduplication and current location; KYC alone does not replace geolocation.

Stripe: the adapter requires a live secret, an enabled Connect platform, owned US Express recipients with active transfers and payouts, manual payout schedules, and a USD bank collected by hosted onboarding. Reservation additionally requires verified bank status and legal-name matching across the current Sumsub extracted identity, the connected individual and the bank holder; missing or mismatched provider evidence cannot approve withdrawal. Name data is used transiently and is never stored in the wallet or returned by the customer API. The platform must have available funds; a virtual SC liability does not fund Stripe's cash balance. Never point payouts at the platform's own bank or accept an arbitrary customer-supplied `acct_`/`ba_` identifier.

**Payment-provider availability is unresolved.** Stripe's published prohibited-business policy includes gambling, sweepstakes with material prizes and skill competitions with monetary/material prizes. A secret key or `COMMERCE_APPROVED` flag is not approval or a way around that policy. Do not activate this model with Stripe absent explicit provider support for the exact business. A supported gaming payment/redemption provider may be required. The included adapter is not evidence that Stripe will onboard GridStake.

References: [Stripe prohibited businesses](https://stripe.com/legal/restricted-businesses), [Connect manual payouts](https://docs.stripe.com/connect/manual-payouts), [Sumsub authentication](https://docs.sumsub.com/reference/authentication), [hosted verification links](https://docs.sumsub.com/reference/generate-websdk-external-link).

## Tax records

`cash_tax_export(p_tenant_id,p_year)` is service-only and returns immutable confirmed gross prizes, returns and net amounts per wallet. It does not collect tax IDs, file tax forms or classify the legal nature of a wager/promotion. The founder's proposed universal $600 net/1099-MISC rule is not adopted. Classification, current thresholds, withholding and filing must follow actual applicable rules; see [IRS 1099-MISC instructions](https://www.irs.gov/instructions/i1099mec) and [W-2G instructions](https://www.irs.gov/instructions/iw2g).

## Migration and operation

Fresh installations use `supabase/schema.sql`; existing v4 databases apply only `supabase/migrations/20261006112856_cash_redemption.sql`. Enum labels commit first, then the financial schema, provenance backfill and procedures install in one transaction. Take the usual backup and migrate during a controlled maintenance period: the backfill intentionally locks wallets, challenges and journals rather than racing live financial writes.

Persistent processes are defined in `ecosystem.config.cjs` and `Procfile`. On a provisioned Node 24 host with real secret-manager values: `npm ci --ignore-scripts`, `npm run build`, `npm run production`. The Docker production image runs `pm2-runtime` with two HTTP instances and separate telemetry, redemption and Discord processes. Cluster reload uses ready signals and graceful HTTP drain. Worker correctness comes from database leases, not a zero-downtime claim. Use `node_modules/.bin/pm2 reload ecosystem.config.cjs --only gridstake-api --update-env` for web reload; restart workers after source changes. Heroku may run Procfile processes separately; actual dynos must be provisioned and scaled.

Register Discord commands intentionally with `npm run discord:register` after the bot's real application ID, token and broker key are configured. Neither a Procfile nor an ecosystem file provisions a host or launches a Discord gateway from Vercel.

## Rules and postal handling

`/sweepstakes-rules.html` includes the founder's A–F proposal, explicit publication status, actual program registry link, corrected implementation terms and unresolved sponsor/address details. It does not present the unverified “100 Production Way” address as a working mailroom. Postal credits require a signed operator's validation of actual received material, a unique evidence digest, current eligibility and an active five-SC program. Each physical request is independently deduplicated and atomically credited; there is no lifetime submission cap. No purchase is required. Postal data/document images stay outside public APIs and ledger text fields.

## Dependency pins

PM2 7.0.4 is pinned with patched `js-yaml` 4.3.2 and `basic-ftp` 6.2.2, and CJS-compatible `chokidar` 4.0.3 to eliminate its vulnerable legacy glob-parser dependency. File watching is disabled in every production process. The actual PM2 CJS ecosystem parser was checked against these installed versions; upgrades must retain this behavior and pass dependency audit.
