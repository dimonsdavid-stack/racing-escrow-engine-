# Vercel deployment

Deploy this directory as the repository root. The root `server.js` exports
an Express application using Vercel's first-class Node.js backend support.
Use Node.js 24, the committed lockfile, and `npm ci`. No build or output
directory override is required. `vercel.json` sets a 60-second function limit,
includes customer app assets, and applies security headers to static responses.

With an authenticated Vercel CLI, from this directory:

```sh
vercel link --yes --project racing-escrow-engine --scope 720studios
vercel deploy --prod --yes --scope 720studios
```

Alternatively import the racing repository into the 720studios Vercel team
and select its production branch. Commit all source except ignored files;
do not commit `.env`, `.vercel`, `node_modules` or real credentials.

## Server environment

Set these encrypted server environment variables on the intended deployment
target, then rebuild:

- `SUPABASE_URL`: the racing ledger's HTTPS project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: its server-only service-role key.
- `TELEMETRY_KEYS_JSON`: the tenant/provider signing registry from `.env.example`.
- `SUPABASE_PUBLISHABLE_KEY`: public auth key from the dedicated racing project.
- `RACING_TENANT_ID`: the dedicated customer tenant UUID.
- `CRON_SECRET`: random secret, at least 32 characters, for the optional HTTP refund worker.

Apply `sql/001_engine.sql`, then `supabase/migrations/20261005224115_customer_app.sql`.
Enable customer enrollment only after Auth confirmation, SMTP and production
redirect URLs are configured. See CUSTOMER_APP.md.

No real secrets are included. Missing or invalid configuration serves the
customer app but returns `503 service_not_configured` to every settlement POST.
The standalone `npm start` retains strict startup validation.

Apply the fresh-install SQL only to the designated racing database. Provision
the tenant, provider, wallets and signing key binding as described in README.md.
Do not attach unrelated projects' database credentials.

## Refund scheduler

Run the CLI `npm run sweep` every
minute on a separate trusted scheduler with the same server credentials.
Alternatively invoke `GET /api/v1/operations/refund-expired` every minute with
`Authorization: Bearer <CRON_SECRET>`. The route processes up to ten overdue
races per invocation with bounded RPC timeouts and reports failures as 503.
Overlapping invocations are safe. Vercel minute cron requires a plan supporting
it; this release does not silently upgrade billing or register a scheduler.
Monitor backlog and increase worker capacity as traffic grows. Verify the
scheduler before creating live funded challenges; it releases expired sessions.

## Live checks

- `GET /`: responsive racing lobby and playable practice app.
- `GET /healthz`: HTTP liveness; expect 200 and `{"status":"ok"}`.
- `GET /api/v1/status`: reports loaded configuration only. It explicitly marks
  database connectivity as unchecked and does not expose secrets or identities.
- `POST /api/v1/telemetry/settle`: expect 503 before configuration; after
  configuration, unsigned JSON must return 401 with no balance mutation.
- After database provisioning, use synthetic GC wallets and a signed final
  event to verify funding, settlement, replay and expiry refunds.

Deployment health does not prove ledger installation, database connectivity,
native concurrency behavior or refund scheduler availability. The native
PostgreSQL CI suite must pass before enabling funded production traffic.

The designated repository is
`https://github.com/dimonsdavid-stack/racing-escrow-engine-`.
It is linked to project `racing-escrow-engine` in the 720studios Vercel team.
Production URL: `https://racing-escrow-engine.vercel.app/`.
The initial deployment is READY on Node 24 with Express. Anonymous HTTP checks
passed for the original service page, liveness, status JSON and page assets. Settlement
returns 503 until configuration is supplied; environment and SQL file requests
return 404. Native PostgreSQL 15/17 CI passed. See VERIFICATION.md for evidence.
