# Activation record

- Web project: `racing-escrow-engine`, Vercel team `720studios`, Node 24 / Express + static Next.js.
- Production database: not configured. Rechecked on 2026-10-06: Supabase discovery is now authorized, but the available projects are four unrelated inactive projects; no dedicated racing database has been selected or initialized. Provisioning requires an explicit organization selection and Supabase cost confirmation.
- Production environment: rechecked on 2026-10-06; the Vercel project has no configured environment variables. Publishing or redeploying the web application does not activate authentication, simulator access, payments, or background workers.
- User sign-in: activation awaits dedicated Supabase credentials, verified auth provider configuration and deployed schema.
- iRacing: official OAuth integration implemented; real authenticated Data API schemas and commercial access not validated without operator credentials.
- ACC: normalization and signed provider report route implemented; no trusted dedicated server has been connected in this session.
- Stripe: paid-session verification and atomic coin fulfillment implemented; checkout remains inactive pending actual merchant authorization and credentials.
- Discord: persistent bot, registration, HMAC broker, and opponent acceptance implemented; no bot token or activated worker service was supplied.
- Version 4 controls: program publication, signed verification receipts, deduplication/review, independent free entry, audit export and private notification code implemented. No actual sponsor program, vendor verification bridge, private Realtime platform setting, or external audit anchor is activated.
- Cash redemption: not implemented/active. Official promotion rules, region/age eligibility, identity verification, redemption partner, and operator workflows require a separate approved launch scope.
- Audience: no claim of 200,000 platform users or production load certification is made.
- Database CLI: automatic approval review blocked a Supabase CLI attempt after third-party PostHog telemetry. Local migration files and database tests were completed without retrying that CLI.

This record distinguishes deployed source and tested behavior from external service activation. Do not mark an item complete merely because its configuration variable is present.

The current operator action is to select a dedicated Supabase organization/project, then supply the actual provider and hosting configuration described in `DEPLOYMENT.md`. No unrelated inactive database was modified during finalization.
