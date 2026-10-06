# Activation record

- Web project: `racing-escrow-engine`, Vercel team `720studios`, Node 24 / Express + static Next.js.
- Production database: not configured in this session. Supabase connector project discovery returned an authorization error on 2026-10-06.
- User sign-in: activation awaits dedicated Supabase credentials, verified auth provider configuration and deployed schema.
- iRacing: official OAuth integration implemented; real authenticated Data API schemas and commercial access not validated without operator credentials.
- ACC: normalization and signed provider report route implemented; no trusted dedicated server has been connected in this session.
- Stripe: paid-session verification and atomic coin fulfillment implemented; checkout remains inactive pending actual merchant authorization and credentials.
- Discord: persistent bot, registration, HMAC broker, and opponent acceptance implemented; no bot token or activated worker service was supplied.
- Cash redemption: not implemented/active. Official promotion rules, region/age eligibility, identity verification, redemption partner, and operator workflows require a separate approved launch scope.
- Audience: no claim of 200,000 platform users or production load certification is made.
- Database CLI: automatic approval review blocked a Supabase CLI attempt after third-party PostHog telemetry. Local migration files and database tests were completed without retrying that CLI.

This record distinguishes deployed source and tested behavior from external service activation. Do not mark an item complete merely because its configuration variable is present.
