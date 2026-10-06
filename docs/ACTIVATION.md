# Activation record

- Web project: `racing-escrow-engine`, Vercel team `720studios`, Node 24 / Express + static Next.js.
- Production database: not configured. Rechecked on 2026-10-06: Supabase discovery is now authorized, but the available projects are four unrelated inactive projects; no dedicated racing database has been selected or initialized. Provisioning requires an explicit organization selection and Supabase cost confirmation.
- Production environment: rechecked on 2026-10-06; only the actual public `APP_ORIGIN` and build telemetry setting are bound; no database or provider secrets are configured. Publishing or redeploying the web application does not activate authentication, simulator access, payments, or background workers.
- User sign-in: activation awaits dedicated Supabase credentials, verified auth provider configuration and deployed schema.
- iRacing: official OAuth integration implemented; real authenticated Data API schemas and commercial access not validated without operator credentials.
- ACC: normalization and signed provider report route implemented; no trusted dedicated server has been connected in this session.
- Stripe: paid-session verification and atomic coin fulfillment implemented; checkout remains inactive pending actual merchant authorization and credentials.
- Discord: persistent bot, registration, HMAC broker, and opponent acceptance implemented; no bot token or activated worker service was supplied.
- Version 4 controls: program publication, signed verification receipts, deduplication/review, independent free entry, audit export and private notification code implemented. No actual sponsor program, vendor verification bridge, private Realtime platform setting, or external audit anchor is activated.
- Cash redemption v4.2: implemented in source, including classification, reservation, live Connect adapter, reconciliation and tax records; not externally activated. No actual Sumsub account, payout provider, funded cash balance or persistent host is connected. Stripe policy explicitly lists prize competitions/sweepstakes as prohibited; the integration does not establish provider eligibility.
- Operator: owner designated Crestside Consultants L.L.C. on 2026-10-06. Formation filing and a public directory identify entity 202359412578 and mailing address 626 Wilshire Blvd, Suite 410, Los Angeles, CA 90017. Published at `/operator.html`, app footer, challenge rules and privacy disclosure. See `docs/OPERATOR.md` for dated sources and current-registry verification limits.
- Rules: founder supplied an A–F proposal on 2026-10-06. Published for review at `/sweepstakes-rules.html` with Crestside as proposed sponsor; no postal entry program is activated. The supplied four-state exclusion list and universal $600 tax claim are not adopted as a verified legal policy.
- Audience: no claim of 200,000 platform users or production load certification is made.
- Database CLI: automatic approval review blocked a Supabase CLI attempt after third-party PostHog telemetry. Local migration files and database tests were completed without retrying that CLI.

This record distinguishes deployed source and tested behavior from external service activation. Do not mark an item complete merely because its configuration variable is present.

The current operator action is to select a dedicated Supabase organization/project, then supply the actual provider and hosting configuration described in `DEPLOYMENT.md`. No unrelated inactive database was modified during finalization.
