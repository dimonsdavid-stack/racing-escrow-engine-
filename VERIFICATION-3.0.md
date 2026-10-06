# Verification record — external simulator platform 3.0.0

Verified application source: `96ee12f9e09d86781058c317e3a06d2932a63f80`.

Successful release workflow: https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/runs/37434199970

| Check | Result |
|---|---|
| Next.js 16.3.8 production static export | Passed |
| Deterministic HTTP/SQL tests | 47 passed on each PostgreSQL matrix job |
| Native PostgreSQL 15 concurrency | Passed, 13 scenarios plus suite parent |
| Native PostgreSQL 17 concurrency | Passed, 13 scenarios plus suite parent |
| Desktop / Pixel browser stories | 6 passed |
| Production dependency audit | Zero reported vulnerabilities |
| Vercel preview build | READY; returned version 3.0.0 |
| Preview root and CSP | HTTP 200, dashboard present, exact inline-script hashes |

Tests cover single funding across eight simultaneous acceptance retries, single purchase fulfillment across eight independent webhook deliveries, ledger conservation, source binding, pre-start settlement rejection, source receipt failure rollback, full zero-fee refunds, SC posting rollback, wrong-opponent refusal, one-use OAuth state/refresh leasing, dirty and nonpositive lap filtering, token tamper protection, download origin restrictions, ACC server ownership mapping, and source-bound bridge retries.

Browser tests cover unconfigured service states, the absence of a browser game, all principal navigation, confirmed wallet rendering, precise fixed payout terms, acceptance and evidence, and stable request identity after ambiguous HTTP failure. The account/browser fixtures are isolated test contracts, not a claimed live Supabase or payment transaction. Real financial authorization and concurrency are exercised in actual PostgreSQL sessions separately.

Desktop and mobile release screenshots were visually inspected from the successful workflow artifacts. They show the external-race dashboard, wallet states, and responsive layout. GitHub retains these CI artifacts for 14 days; the workflow and browser source reproduce them. Browser verification was run in GitHub Actions because the local browser runtime was unavailable.

Publishing the source does not certify live iRacing Data API schemas, provider permissions, merchant approval, production Supabase authentication, ACC host connectivity, Discord Gateway operation, cash redemption, legal eligibility, or operation at a claimed 200,000-user scale. See `docs/ACTIVATION.md` for the explicit activation record. The database integration was not applied to an unrelated project; Supabase project discovery returned an authorization error.

The old `VERIFICATION.md` and `VERIFICATION-1.1.md` are historical records superseded by this release.
