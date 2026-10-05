# Customer application — 2.0.0

The shipped UI is a responsive racing application, rather than the old API
status screen. The original branding uses an original vector circuit treatment,
dark navigation shell and clear GC/SC context. Its primary conversion is to
immediately playable free practice. It does not fabricate opponent activity,
competition results, balances or eligibility.

## User flows

| Surface | Implemented behavior | Production dependency |
|---|---|---|
| Lobby and practice | Three circuits, discovery, difficulty/search, desktop/mobile navigation | None |
| Driving | Canvas physics, keyboard/pointer controls, pause on blur, restart, ordered sectors, three-lap sessions | None |
| Personal records | Positive clean lap selection, browser persistence, clear-history control | Browser storage |
| Accounts | Signup, confirmation, sign-in, refresh, sign-out, recovery callback and password change | Dedicated Supabase Auth; email delivery and redirect configuration |
| Profile and allowance | Verified-session enrollment; journaled 1,000 GC welcome and once-per-UTC-day 100 GC | Customer SQL migration and enabled tenant |
| Wallet | Separate exact-decimal GC/SC balances; all active escrow liabilities; journal history | Authenticated customer RPCs |
| Challenge offer | Immutable circuit/currency/fee/provider/window; expires in 15 minutes; cancel before funding | Enabled provider and track |
| Acceptance | Review terms, lock both wallets and create escrow in one transaction; stable offer identity on retries | Both verified accounts, sufficient balances, provider connection |
| Outcomes and receipts | Status, deadline, provider session UUID, escrow and rake charged | Signed provider telemetry or refund worker |
| Participation pause | One hour/day/week; SQL prevents shortening; new funding is blocked | Customer profile |
| GC purchases / SC redemption | Disabled; no payment details collected | Payment/redemption integration, approved product and operational eligibility rules |

Browser practice is deliberately outside the financial trust boundary. A
customer cannot submit browser timings or `is_clean` flags to unlock escrow.
The connected provider must host/validate the actual funded session and send
the signed final telemetry defined in README.md. A receipt's UUID is the
session binding; provider delivery/join integration is an operator dependency.

## Database activation

Apply the core fresh-install script first, then the customer migration:

1. `sql/001_engine.sql`
2. `supabase/migrations/20261005224115_customer_app.sql`

Supabase supplies `auth.users`, `auth.sessions`, `auth.uid()` and API roles.
The tests use disposable minimal auth fixtures; they are not production auth
migrations. Keep `race_private` out of the exposed Data API schemas.

Provision a dedicated tenant, initially with SC disabled. Do not borrow the
credentials of an unrelated project. Example, executed by the migration owner:

```sql
BEGIN;
INSERT INTO race_private.tenants(id,name,customer_signup_enabled)
VALUES ('11111111-1111-4111-8111-111111111111','Racing',true);
INSERT INTO race_private.tracks(tenant_id,id,title) VALUES
('11111111-1111-4111-8111-111111111111','coastal','Coastal Sprint'),
('11111111-1111-4111-8111-111111111111','club','Club Circuit'),
('11111111-1111-4111-8111-111111111111','night','Night Run');
COMMIT;
```

Configure the production environment with the racing project's HTTPS
`SUPABASE_URL`, **publishable/legacy anon** `SUPABASE_PUBLISHABLE_KEY`, and
`RACING_TENANT_ID`. Service-role and `sb_secret_` keys are rejected from the
public configuration. Auth URLs currently support standard `*.supabase.co`
project origins, matching the restrictive browser connection policy.

Enable confirmed-email signup, set the site URL to the public racing domain,
allow the root and `/#recovery` redirect URLs, and configure reliable SMTP,
auth rate limits and abuse protection. Confirmed-email sessions with a live
`auth.sessions` record are required at the SQL boundary. Token identity is
revalidated by Supabase Auth at the Express boundary; request-body actor IDs
are rejected. Tokens arriving in an email callback fragment are removed from
the URL before asynchronous work. Refresh tokens live in session storage;
access tokens stay in memory. No auth secret is rendered into HTML.

Tracks remain disabled until their provider ID and session window are set by
operations. Test provider/session delivery, final-event retry retention and the
refund worker before enabling funded play. Configure server-only
`SUPABASE_SERVICE_ROLE_KEY` and `TELEMETRY_KEYS_JSON` for settlement. The
creator accepts by posting the immutable offer; the opponent explicitly accepts
before funding. No wallet is deducted merely by posting an offer.

Run `npm run sweep` at least once a minute, or schedule the protected HTTP
worker described in DEPLOYMENT.md. Neither missing credentials nor a signing
configuration failure prevents free practice. Invalid provider signatures
cannot mutate balances. HTTP/database interruption uses the same stored offer
or event identity on retry, never a separate balance update.

SC remains disabled by default at both tenant and profile levels. Activation
must establish the actual operator, applicable jurisdictions, eligibility and
verification, official promotional rules, funding/redemption rails and dispute
operations. The informational UI describes the implemented mechanics; it is
not a substitute for an operator's finalized commercial terms.

## Verification

`npm test` exercises the real SQL migrations in PGlite, HTTP authorization and
failure behavior, and driving physics. `npm run test:concurrency` requires a
fresh disposable native PostgreSQL database and refuses existing installations.
It includes eight independent authenticated acceptors and competing opponents,
in addition to the core finance contention/failure-injection suite. CI runs it
on PostgreSQL 15 and 17.

`npm run test:browser` runs Chromium desktop and Pixel 7 viewport checks against
the actual Express app. It checks navigation, search, currency/account gating,
keyboard/pointer driving, pause/restart, horizontal overflow, console errors
and absence of browser settlement submissions. Screenshots and failure traces
are retained in GitHub Actions. Set `BROWSER_BASE_URL` to test a deployed URL.
