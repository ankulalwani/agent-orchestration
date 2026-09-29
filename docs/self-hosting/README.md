# Self-hosting

A self-hosted control plane is the API, the web dashboard, MongoDB and (optionally) Redis. Workers run natively on developer machines and connect *outbound* to it, so no inbound ports are needed on those machines.

Self-hosted installations:
- make no calls to vendor infrastructure (no licence checks, telemetry or marketplace);
- impose no limits on tasks, workers, projects or execution time;
- keep private capabilities, prompts and code on your own infrastructure.

## Option A: Docker Compose

> **Verification status:** run on 2026-09-28 with Docker Desktop (Engine 29.8, WSL 2) on Windows 11: the
> image builds (about 430 MB; production dependencies installed from the lockfile), `docker compose up`
> starts healthy `control-plane`, `mongo` and `redis`, the dashboard is served, and a worker on the host
> paired with it and completed a task (dispatch through Redis, verification, commit, artifact upload and
> download). Data in MongoDB and artifacts survive recreating the containers.

```bash
cp .env.example .env
# set JWT_SECRET and ENCRYPTION_KEY (see comments in .env.example)
docker compose up -d --build
# open http://localhost:4000 and create the first account (it becomes the platform administrator)
```

Services: `control-plane` (API + web on port 4000), `mongo` (MongoDB 7), `redis` (Redis 7 with AOF persistence). Add MinIO with `--profile storage`. Volumes: `mongo-data`, `redis-data`, and `artifacts` (task screenshots and logs, unless S3 is configured).

One-off commands run in the container, for example `docker compose exec control-plane node apps/api/dist/main.js reencrypt-secrets`.

### Production

```bash
DOMAIN=orchestrator.example.com docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

This adds Caddy with automatic HTTPS, stops exposing port 4000 directly, trusts the proxy, and sets resource limits. `ports: !reset []` needs Docker Compose 2.24 or newer.

After the first account is created, set `ALLOW_REGISTRATION=false` and add members from **Settings → Members**. People who don't have an account get a single-use invitation link, which lets them register even with registration closed. Without SMTP, copy the link shown after inviting and send it yourself.

## Option B: Node.js directly (verified)

```bash
npm install -g pnpm        # switches to the version pinned in package.json
pnpm install --frozen-lockfile
pnpm --filter @ao/web build
pnpm --filter @ao/api build
pnpm --config.node-linker=hoisted --filter @ao/api deploy --prod /opt/agent-orchestrator/api
cp -r apps/web/dist /opt/agent-orchestrator/web

cd /opt/agent-orchestrator/api
MONGODB_URI=mongodb://127.0.0.1:27017/agent_orchestrator \
JWT_SECRET=… ENCRYPTION_KEY=… \
WEB_DIST_DIR=/opt/agent-orchestrator/web PUBLIC_URL=https://orchestrator.example.com WEB_URL=https://orchestrator.example.com \
node dist/main.js
```

These steps were run on Windows 11 against MongoDB 8.3. `/readyz` reported ready, the dashboard was served, and API 404s returned JSON. Run the process under your service manager (systemd, etc.) behind a TLS reverse proxy that forwards WebSockets.

## Configuration

Settings are environment variables, validated at startup. Invalid configuration stops the process with a list of problems. See [.env.example](../../.env.example). Settings marked *web* can instead be managed in the dashboard without a restart (see [Server settings in the dashboard](#server-settings-in-the-dashboard)).

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | ≥ 32 characters |
| `ENCRYPTION_KEY` | yes | 64 hex characters. Encrypts organization secrets. **Back it up**: without it, stored secrets cannot be recovered. |
| `ENCRYPTION_KEYS_PREVIOUS` | during key rotation | Comma-separated former `ENCRYPTION_KEY` values, used only to decrypt. See [Rotating ENCRYPTION_KEY](#rotating-encryption_key). |
| `MONGODB_URI` | yes | MongoDB is the source of truth |
| `REDIS_URL` | recommended | Enables BullMQ dispatch. Without it an in-memory queue is used, which is suitable for a single API instance only. |
| `PUBLIC_URL`, `WEB_URL`, `CORS_ORIGINS` | yes in production | Used for pairing links, emails and CORS. `WEB_URL` and `CORS_ORIGINS` are *web* |
| `TRUST_PROXY` | behind a proxy | Correct client IPs for rate limits and audit |
| `SMTP_URL`, `SMTP_FROM` | optional, *web* | Without SMTP, emails are logged, not sent |
| `ALLOW_REGISTRATION`, `REQUIRE_EMAIL_VERIFICATION` | optional, *web* | The first user can always register |
| `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_DAYS`, `RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT_PER_MINUTE` | optional, *web* | Session lifetimes (900 s, 30 days) and requests per minute per client (300; sign-in routes 20) |
| `EXPO_PUSH_ENABLED`, `TELEMETRY_ENABLED` | optional, *web* | Outbound calls, off by default |
| `FEATURE_FLAGS` | optional | Comma-separated feature flags forced on for everyone. Otherwise manage flags in the dashboard (**Feature flags**). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional, *web* | "Continue with Google". See [Sign-in providers](#sign-in-providers-oauth--openid-connect). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | optional, *web* | "Continue with GitHub". For GitHub Enterprise Server also set `GITHUB_URL` and `GITHUB_API_URL`. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | optional, *web* | Any OpenID Connect provider (Microsoft Entra ID, Okta, Keycloak, Auth0, GitLab, …). `OIDC_DISPLAY_NAME` sets the button label; `OIDC_SCOPES` defaults to `openid email profile`. |
| `METRICS_ENABLED` | optional | Prometheus at `/metrics` |
| `ERROR_TRACKING_DSN` | optional, *web* | Sentry-compatible DSN (Sentry, GlitchTip, …). Off unless set. Reports server errors (5xx) and crashes, redacted, with the request's correlation id and route pattern, never request bodies or URLs. |
| `ERROR_TRACKING_WEBHOOK_URL` | optional, *web* | Alternatively (or also), POST each error report as JSON to this URL |
| `ERROR_TRACKING_ENVIRONMENT` | optional, *web* | Environment name on reports (defaults to `NODE_ENV`) |

Health: `GET /healthz` (liveness) and `GET /readyz` (MongoDB and queue).

### Server settings in the dashboard

Platform administrators (the first account on a new server) see **Server settings** in the dashboard: the
effective value and source (environment, set in the dashboard, or default) of every variable in this
table, with secrets shown only as set or not set, and the live status of the database, queue, email,
storage and sign-in providers.

Settings marked *web* above have a **Change** button:

- A change applies at once, without a restart. Other API instances pick it up within 10 seconds.
- **An environment variable always wins.** A *web* setting that is also set in the environment is shown as
  *locked*. To manage it in the dashboard, remove it from the environment (for Docker Compose, from `.env`)
  and restart once.
- Secrets (client secrets, and URLs that may contain a password: `SMTP_URL`, `ERROR_TRACKING_DSN`,
  `ERROR_TRACKING_WEBHOOK_URL`) are stored encrypted with `ENCRYPTION_KEY` and included in
  [key rotation](#rotating-encryption_key). They are never shown again; to change one, enter the complete
  new value.
- Values are validated with the same rules as the environment variables. Changes are recorded in the
  audit log by name, without values.
- Everything else (database, Redis, keys, ports, storage, `PUBLIC_URL`, `TRUST_PROXY`, intervals) is read
  once at startup and stays environment-only.

**Feature flags** (also for platform administrators) turns optional features on for all organizations,
with exceptions for single organizations. `FEATURE_FLAGS` in the environment forces a flag on for everyone.

## Demo data

To try the dashboard on a new, empty installation:

```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='a-long-password' node dist/main.js seed-demo
```

(with Docker Compose: `docker compose exec -e SEED_ADMIN_EMAIL=… -e SEED_ADMIN_PASSWORD=… control-plane node apps/api/dist/main.js seed-demo`).
This creates the administrator account, a *Demo organization*, an *Example project* with project knowledge,
and an example skill. It refuses to run on a database that already has users.

## Publishing worker releases

The control plane hosts worker updates for the workers connected to it. Releases are signed offline, so
a compromised server can't push code to workers:

1. Once, create a release key on a machine you trust, and keep the private key offline:
   `node scripts/sign-release.mjs keygen release-2026`. Give `release-2026.public.pem` to your workers
   (worker UI → **Updates → Trusted release keys**).
2. Build the package: `node scripts/package-worker.mjs --tarball`.
3. In the dashboard, **Server → Worker releases**: choose the channel and version, and upload the package.
   The page shows the exact signing command, with the package URL on this server.
4. Sign on the machine with the key (`node scripts/sign-release.mjs sign … > manifest.json`) and upload
   `manifest.json`. The server checks that it describes the uploaded package at its own URL, then
   serves it at `/api/v1/worker-releases/<channel>/manifest.json`.

Workers with automatic updates install it within 6 hours; others show it under **Updates**. Uploads and
publications are recorded in the audit log.

## Backups

See [backup-restore.md](backup-restore.md).

## Sign-in providers (OAuth / OpenID Connect)

Each provider is off until its client id and secret are set. Create an OAuth application with the
provider and register this redirect URI (it uses `PUBLIC_URL`):

```
<PUBLIC_URL>/api/v1/auth/oauth/<google | github | oidc>/callback
```

- An identity signs in to the account it is connected to. Otherwise, if the provider confirms the email
  address is verified and an account with that email exists, the identity is connected to it. Otherwise
  a new account is created, subject to `ALLOW_REGISTRATION`. Invitation links also offer the providers.
- Two-factor authentication still applies to accounts that have it on.
- Users connect and disconnect providers under **Settings → Your account**. An account created through a
  provider has no password until the user sets one with "Forgot password".
- Only the OIDC provider type is tested against a local stand-in provider; Google, GitHub and specific
  OIDC vendors have not been tried with real accounts.

## Rotating ENCRYPTION_KEY

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set `ENCRYPTION_KEY` to the new key and `ENCRYPTION_KEYS_PREVIOUS` to the old one, then restart the
   control plane. It keeps reading secrets encrypted with the old key and re-encrypts them with the new
   key in the background.
3. Confirm with `node dist/main.js reencrypt-secrets` in the API directory (same environment), or
   `docker compose exec control-plane node apps/api/dist/main.js reencrypt-secrets`.
   It re-encrypts anything left and prints a summary. Exit code 0 means every secret uses the new key;
   exit code 2 lists secrets that no configured key can decrypt, which are left untouched.
4. Remove `ENCRYPTION_KEYS_PREVIOUS` and restart. Keep the old key in your backup store for as long as you
   keep database backups made before the rotation.

## Upgrading

1. Back up MongoDB and your `.env` (including `ENCRYPTION_KEY`).
2. Pull the new version and rebuild (`docker compose up -d --build`, or repeat the Node.js build steps).
3. Indexes and data migrations run automatically at startup. Migrations take a lock, so several API instances can start at once.

Workers keep running during a control-plane upgrade: they buffer events and retry state changes until the control plane is back.
