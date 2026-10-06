# Runtime configuration inventory

Use `.env.production.example` as the complete deployment template. Empty secrets are deliberate: there are no real credentials supplied to this repository. Populate the hosting secret manager; do not commit a filled `.env.production`. The dashboard retrieves the public publishable configuration from the same-origin API, so no `NEXT_PUBLIC_*` secret or rebuild-time Supabase key is needed.

| Variable | Process / meaning |
|---|---|
| `NODE_ENV` | Web and workers; `production` |
| `NEXT_TELEMETRY_DISABLED` | Build; `1` |
| `PORT` | Standalone web process; default 3000, host may set |
| `APP_ORIGIN` | Exact public HTTPS origin, currently `https://racing-escrow-engine.vercel.app` |
| `CORS_ALLOWED_ORIGINS` | Optional comma-separated additional exact HTTPS browser origins; no wildcard |
| `SUPABASE_URL` | Dedicated project's real HTTPS `*.supabase.co` origin |
| `SUPABASE_SERVICE_ROLE_KEY` | Server/worker administration only; never browser configuration |
| `SUPABASE_PUBLISHABLE_KEY` | Actual publishable or legacy anon key; served publicly |
| `RACING_TENANT_ID` | Provisioned tenant UUID, validated by all customer RPCs |
| `CRON_SECRET` | Random secret at least 32 characters for refund watchdog |
| `TELEMETRY_KEYS_JSON` | Trusted racing source keyring |
| `DISCORD_BROKER_KEYS_JSON` | Separate bot broker keyring |
| `COMPLIANCE_KEYS_JSON` | Separate trusted identity/location/risk bridge keyring |
| `OPERATOR_KEYS_JSON` | Separate operator program publication/review keyring |
| `REALTIME_ENABLED` | `false` until private Realtime authorization/public-access settings validated |
| `COMMERCE_APPROVED` | `false` until actual business-model authorization; a flag is not merchant permission |
| `STRIPE_SECRET_KEY` | Actual merchant secret for the authorized environment |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this exact webhook endpoint/environment |
| `IRACING_CLIENT_ID` | Issued official OAuth client ID |
| `IRACING_CLIENT_SECRET` | Issued OAuth client secret when required by client registration |
| `IRACING_DOWNLOAD_HOSTS` | Exact comma-separated temporary result hosts verified through approved Data API use |
| `OAUTH_ENCRYPTION_KEY` | Random 32-byte base64 AES-GCM key; shared securely by API/worker |
| `IRACING_OPERATOR_AUTH_USER_ID` | Supabase auth UUID of the connected authorized operator account |
| `DISCORD_BOT_TOKEN` | Persistent bot host only |
| `DISCORD_CLIENT_ID` | Discord application ID for intentional slash-command registration |
| `DISCORD_BROKER_KEY_ID` | Bot host key ID matching server broker keyring |
| `DISCORD_BROKER_SECRET_BASE64` | Bot host random at least 32-byte base64 signing secret |
| `BACKEND_API_BASE_URL` | Exact HTTPS API origin; currently same as `APP_ORIGIN` |
| `ACC_PROVIDER_KEY_ID` | Dedicated ACC bridge key ID matching telemetry ring |
| `ACC_PROVIDER_SECRET_BASE64` | Dedicated ACC bridge signing secret |
| `SIGNING_KEY_ID` | Trusted operator/provider shell only, for `scripts/send-signed.js` |
| `SIGNING_SECRET_BASE64` | Trusted operator/provider shell signing material for that role only |
| `TELEMETRY_KEY_ID`, `TELEMETRY_SECRET_BASE64` | Optional local legacy signed-ingress smoke script only |
| `DATABASE_URL`, `RACING_ALLOW_TEST_DATABASE` | Disposable native tests only; never a production database |
| `BROWSER_BASE_URL`, `CI` | Optional browser test target and CI behavior |

Each keyring is a JSON array of objects with `key_id`, `tenant_id`, `provider_id`, `secret_base64`. IDs resolve to an enabled, explicitly provisioned tenant/provider. Secrets must decode canonically to at least 32 random bytes; generate with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` on the trusted host. Do not copy an example or shared prompt secret. Use distinct key IDs and secrets across process roles. Rotation permits overlapping distinct IDs mapped to the same identity; retire old keys deliberately. Losing the OAuth encryption key requires reconnecting provider accounts.

## Endpoint alignment

| Service | Exact integration path |
|---|---|
| Supabase auth | Site URL `APP_ORIGIN`; allow callback URL `APP_ORIGIN/#identity` as required by the chosen auth flow |
| iRacing OAuth | `APP_ORIGIN/api/v1/identity/iracing/callback` |
| Steam OpenID | `APP_ORIGIN/api/v1/identity/steam/callback` |
| Stripe webhook | `BACKEND_API_BASE_URL/api/v1/stripe/webhook` |
| Coin checkout | `POST /api/v1/stripe/create-checkout`; same-origin authenticated customer |
| Racing report | `POST /api/v1/telemetry/settle` |
| Future event registration | `POST /api/v1/providers/events` |
| Verification assertions | `POST /api/v1/compliance/receipts` |
| Official program | `POST /api/v1/compliance/programs/publish` then `/activate` |
| Review decision | `POST /api/v1/compliance/reviews/resolve` |
| Discord invitation/acceptance | `POST /api/v1/challenges/initiate`, `/api/v1/challenges/accept` |
| Deadline watchdog | `GET /api/v1/operations/refund-expired`; Bearer `CRON_SECRET` |

Send an operator JSON file using `node scripts/send-signed.js /api/v1/compliance/programs/publish /secure/path/program.json operator`. The script requires the trusted shell's actual key configuration, signs the file's exact bytes and refuses redirects. Build program JSON from approved operator terms, including rule document digest and authorization reference. Reuse the same file and change UUID on interrupted requests. Verification bridges use role `compliance`, racing hosts use `telemetry`. No browser should possess these credentials.

Vercel runs the stateless Express web/API with the static Next.js export. Render, Heroku or another container host runs persistent `node src/worker.js` and `node discord/bot.js` as separate services using the same dedicated database and correctly separated secrets. This release does not provision those hosts or claim to run a permanent Discord Gateway inside a Vercel function.
