# GridStake 4.2 verification

## Release contents

Won-SC classification and historical audit-based backfill; atomic withdrawal reservation; hosted Sumsub verification and owned Stripe Connect bank onboarding; production-only payout reconciliation and bank-return compensation; signed postal receipt crediting; operator review wake-up; PM2/Procfile operation; public program proposal and active-rules registry.

## Local evidence

- Full fresh-install SQL compiles, including the four versioned migrations.
- 77 HTTP, provider-transport and SQL checks pass with no failures or skips.
- Production Next.js static export builds successfully.
- Production dependency audit reports zero known vulnerabilities after exact dependency overrides.
- Actual installed PM2 7.0.4 parses `ecosystem.config.cjs`: four processes, two clustered HTTP instances, ready signaling and graceful drain configuration.
- `git diff --check` passes.

## Hosted verification

The [verification workflow](https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/workflows/verify.yml) runs PostgreSQL 15 and 17 against independent connections, including eight competing cash requests and eight duplicate retries. It also runs desktop/mobile browser journeys, including persisted redemption retry across reload and the public rules page, and uploads reports/screenshots. Use the run associated with the deployed commit for its result; local SQL checks alone do not prove concurrent independent-session behavior.

## Production activation

The public app is [racing-escrow-engine.vercel.app](https://racing-escrow-engine.vercel.app/); rules are at [/sweepstakes-rules.html](https://racing-escrow-engine.vercel.app/sweepstakes-rules.html). Actual public origin and framework telemetry setting are bound in Vercel. No dedicated GridStake Supabase project, provider secrets, funded payout account or persistent worker host is connected. All provider interactions require actual credentials. No cash payout, live KYC result or commercial authorization is claimed by this release record. See [activation record](docs/ACTIVATION.md) and [redemption integration](docs/REDEMPTION.md).

The founder's A–F rules proposal is published with its status and unresolved sponsor/address details. It is not presented as an activated program or a verified territorial/legal policy. The deployment does not claim 200,000 users, certified load capacity, universal legality, zero operational risk or kernel anti-cheat.
