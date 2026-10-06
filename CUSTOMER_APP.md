# Customer application

The customer app is now the Next.js external-simulator P2P dashboard in `frontend/app/page.js`. The previous browser driving/physics code has been removed.

Navigation covers the challenge lobby, real event calendar, accepted challenges and evidence, separate GC/SC wallets and journal history, verified iRacing/Steam/Discord connections, help, and participation pauses. Desktop has a fixed paddock sidebar; mobile has bottom navigation and responsive cards. Forms show fixed payout/refund terms before consent. Auth is verified Supabase sign-in, not a mock Discord handle. Customer IDs are provider verified, not freely editable fields. API failures display unconfirmed status and preserve the same request ID for retry.

The dashboard contains no invented races, coin balances, customer counts, payment confirmations, or enabled withdrawals. Missing integration setup is visible. Every financially effective action requires the real atomic PostgreSQL RPC boundary. Refer to `docs/API.md`, `docs/ARCHITECTURE.md`, and `DEPLOYMENT.md` for the contracts and activation requirements.
