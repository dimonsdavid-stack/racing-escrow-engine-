# GridStake 4.0 verification record

## Scope

The release adds source-bound transactional settlement, formal promotion versions and consent, signed verification assertions, tenant-scoped identity deduplication and review, independent AME credits/receipts, bounded request admission, event lap-time bounds, per-wallet hash-chain audit exports, private wallet invalidations, and mobile help/commerce flows. Existing real-simulator and purchase pipelines remain active code paths, with production integrations disabled until actual operator configuration exists.

## Completed local checks

- `npm run build`: production Next.js static export and generated full SQL compile successfully.
- `npm test`: 59 HTTP, provider, failure and database scenarios pass, zero skipped or failed.
- New full-schema tests exercise expired location, duplicate person identities, exact-once free credit, quota enforcement, immutable catalog/receipts, source-bound payout comparison, full zero-rake dirty-race refunds, sealed journal tampering and deferred-audit rollback.
- Private wallet policies are tested with unrelated broad permissive receive/publish policies present; foreign wallet reads and client publishing remain blocked.
- `git diff --check`: clean.

## CI gates

The repository workflow builds and runs all local scenarios, disposable PostgreSQL 15/17 independent-connection tests, production dependency audit, and desktop/mobile Playwright flows. Release acceptance requires the exact source commit's workflow to succeed. Its immutable run and screenshots are available under repository Actions. Native tests add concurrent identical AME retries, competing quota requests, concurrent person-key collision and deferred audit rollback to the existing escrow/payment/deadlock scenarios. Browser tests add disabled free-entry and consent/retry/confirmed-award journeys.

This source record is authored before CI/deployment and makes no claim that a future run passed. Verify the exact commit in GitHub Actions and the Vercel deployment's Git SHA before promotion.

## Production boundary

A web deployment alone does not apply the schema or connect a real verification, simulator or merchant account. A dedicated racing Supabase project has not been selected, no operational credentials or sponsor-approved rules have been supplied, and persistent worker services are not deployed. Cash redemption remains unimplemented. Private Realtime platform settings, external immutable audit anchoring and monitoring drains need operator activation. Mocked browser transport and disposable database tests do not establish production load capacity or legal eligibility.
