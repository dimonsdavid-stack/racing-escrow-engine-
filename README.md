# GridStake / Racing Escrow Engine

A mobile web P2P challenge and validation layer for **external iRacing and ACC sessions**. There is no browser driving game. The Next.js dashboard uses an Express REST API and tenant-isolated PostgreSQL RPCs. Funding, settlement, refunds, and coin purchase fulfillment each execute inside a single database transaction.

**Production URL:** https://racing-escrow-engine.vercel.app/

**Current release:** 3.0.0. Publishing the web application does not activate external accounts, payments, simulator access, or cash redemption. Those services require operator credentials and verified program configuration. The UI exposes the actual configured state and never invents wallet balances, races, player counts, or checkout success.

## Project files

| File | Purpose |
|---|---|
| `supabase/schema.sql` | Generated fresh-install schema; includes three atomic migrations |
| `sql/001_engine.sql` | Double-entry journal, wallet projection, escrow, settlement and full refunds |
| `supabase/migrations/20261006073056_sim_racing_commerce.sql` | Verified driver identities, scheduled events, consent, source evidence, durable result jobs, OAuth leases, commerce |
| `server/app.js`, `server.js` | Shared Express application / Vercel entrypoint |
| `src/customer.js` | Verified customer session boundary and strict REST schemas |
| `src/providers.js`, `src/provider-routes.js` | External simulator result adapters and signed provider ingress |
| `src/oauth.js` | iRacing OAuth PKCE, Steam OpenID, AES-GCM token encryption and one-use refresh leases |
| `src/commerce.js` | Hosted checkout and raw-signature Stripe webhook fulfillment |
| `src/worker.js` | Durable provider-result processing and deadline refunds |
| `frontend/app/page.js`, `frontend/app/globals.css` | Next.js responsive customer dashboard |
| `discord/bot.js` | Slash command broker and actual invited-opponent acceptance |
| `.env.production.example` | Required server configuration; no operational credentials |
| `docs/ARCHITECTURE.md` | Financial, tenant, consent, and provider trust boundaries |
| `docs/API.md` | Routes and provider payload contracts |
| `DEPLOYMENT.md` | Deployment, activation, testing, rollback, and operational procedure |
| `docs/PROJECT_LINKS.md` | Public domains, repository, source and operator consoles |

## Local development

Node 24 is required. `npm ci --ignore-scripts`, `npm run build`, then `npm run dev` serves the actual exported Next.js app with safely disabled external integrations. Production standalone hosting uses `npm start` after server configuration is complete. Vercel builds the static Next.js UI and serves it through the same Express origin.

`npm test` verifies HTTP/SQL contracts and failure behavior. `npm run test:browser` verifies the built UI on desktop and mobile. `npm run test:concurrency` requires a **new disposable** PostgreSQL database and `RACING_ALLOW_TEST_DATABASE=1`; it refuses an existing engine schema. GitHub Actions runs native PostgreSQL 15/17 and browser checks.

## Activation

Apply the schema to a dedicated Supabase project, provision a tenant/provider, and supply the server environment in the hosting secret manager. Enable verified sign-in providers and exact OAuth redirect URLs. Register only scheduled future events through the trusted provider boundary. Run the persistent result worker and Discord bot in separate containers. Activate commerce only with merchant authorization for the actual business model and an approved catalog. SC eligibility, regional program requirements, official rules, and a redemption provider are separate activation requirements; the code does not claim to grant regulatory or simulator commercial permission.

The public dashboard is independently usable for navigation and integration status before activation. The operational challenge and wallet features require a live database and verified account. A deployment with missing configuration returns explicit unavailable responses rather than fabricated data.
