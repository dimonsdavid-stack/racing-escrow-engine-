> Historical verification. The current external-simulator platform record is [VERIFICATION-3.0.md](VERIFICATION-3.0.md).

# Verification record — customer application 2.0.0

Canonical app: https://racing-escrow-engine.vercel.app/
Repository: https://github.com/dimonsdavid-stack/racing-escrow-engine-
Verified application commit: `a248f934cf6a4586dfb71922c23af80212021706`.
Verified CI run: https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/runs/37387451088
Vercel project: `prj_VcK7s2BN3AY78hp6frEg8JUInaeq`, team `720studios`.

## Executed checks

- Local `npm test`: **39 passed; zero failed or skipped**, Node 24.19.0.
- Registry `npm audit --omit=dev`: **zero production vulnerabilities reported**.
- GitHub Actions PostgreSQL 15 and 17: both jobs succeeded with the exact lockfile,
  deterministic SQL/HTTP tests, independent-connection concurrency tests and audit.
- Native contention suite: twelve scenarios, including funding overspend, final
  event replay, competing final events/refunds, observed lock waits, transaction
  rollback, backend cancellation, SERIALIZABLE conflicts, GC/SC separation,
  eight authenticated acceptance retries and competing opponent acceptors.
- Chromium browser suite: **six passed**; three stories on desktop and Pixel 7
  viewport. Practice keyboard/pointer controls, pause/restart, route navigation,
  search/filter, missing-account gating, horizontal overflow and script errors
  were checked against the actual Express server.
- The confirmed-account UI story uses isolated API fixtures to test exact
  decimal displays, acceptance consent, receipt rendering and wallet layout.
  It does not claim a production Supabase login or financial transaction.
  Real customer SQL session authorization, grants and funding were separately
  executed by the PGlite/native PostgreSQL suites.
- Actual driving simulation completes three clean clockwise laps on each of
  the three circuits. Browser practice never posts a settlement request.

## Evidence

The CI run retains JUnit test reports and desktop/mobile screenshots:

- Browser evidence: https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/runs/37387451088/artifacts/11379502598
- PostgreSQL 15: https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/runs/37387451088/artifacts/11380206907
- PostgreSQL 17: https://github.com/dimonsdavid-stack/racing-escrow-engine-/actions/runs/37387451088/artifacts/11378982720

Artifacts follow the configured fourteen-day retention. Source tests and the
CI workflow remain in the repository for reproduction. The prior service-only
release's historical record is VERIFICATION-1.1.md.

## Production activation boundary

Free practice, track discovery, navigation and local records require no
backend secrets. A dedicated racing Supabase project has not been provisioned.
Customer account, wallet and challenge code is implemented and tested, but live
account activation remains disabled. Existing unrelated projects were not used.
No live customer wallet was credited, funded or settled in verification.

Trusted race-provider session delivery and final telemetry, live refund
scheduling, production Auth/SMTP, and SC eligibility/payment/redemption
integrations remain operator dependencies. Commerce and cash redemption are
not implemented payment rails and are explicitly unavailable in the UI.
Deployment and successful test evidence do not establish a fully activated
commercial sweepstakes operation. CUSTOMER_APP.md records each implemented
flow and its actual activation dependency.
