# Architecture Decision Record

Format: ID · date · decision · reason · consequences.

## D-001 · 2026-09-27 · Fastify for the control-plane HTTP/WS server
Fastify gives schema-friendly routing, good performance, first-party WebSocket (`@fastify/websocket`),
rate limiting, CORS and helmet plugins. Zod contracts are validated in handlers via a small helper
rather than a type-provider dependency, to keep contracts framework-independent.

## D-002 · 2026-09-27 · Consolidate spec §69 packages into fewer packages
Spec §69 lists ~30 packages. Many (scheduler, fallback-engine, provider-router, usage-manager,
security, logger…) are small pure-logic modules. Splitting them now multiplies build config without
benefit (§134 "avoid over-engineering"). They live as modules in a handful of packages (mapping in
ARCHITECTURE.md §3). Modules have no cross-cutting imports, so they can be extracted later.

## D-003 · 2026-09-27 · MongoDB is the claim authority; queue is a dispatch signal
Atomic claims use Mongo `findOneAndUpdate` with a status precondition. BullMQ/Redis only wakes the
scheduler and holds delayed jobs (e.g. limit retry wake-ups). If Redis is lost, the scheduler's
periodic sweep re-derives work from Mongo, so no task is lost (§17, §86). An in-memory queue driver
implements the same interface for development and tests.

## D-004 · 2026-09-27 · Password hashing with Node `crypto.scrypt`
Avoids native build dependencies (argon2/bcrypt) that complicate Windows worker/API installs.
Parameters N=16384, r=8, p=1, 64-byte key, per-user random salt, stored as `scrypt$N$r$p$salt$hash`.

## D-005 · 2026-09-27 · Tokens
Access tokens: JWT (HS256, 15 min) via `jose`. Refresh tokens: random 32 bytes, stored SHA-256
hashed, rotated on use; reuse of a rotated token revokes the family. Worker credentials: random
opaque token issued at pairing approval, stored hashed server-side.

## D-006 · 2026-09-27 · Worker credential storage
Worker uses the OS credential store via `@napi-rs/keyring` (Windows Credential Manager, macOS
Keychain, Linux Secret Service). If unavailable (e.g. headless Linux without Secret Service), it falls
back to an AES-256-GCM encrypted file whose key file has 0600 permissions, and reports a
diagnostics warning. Plaintext JSON is never used (§13).

## D-007 · 2026-09-27 · Testing stack
Vitest for unit/integration. Integration tests use `mongodb-memory-server`, pointed at a system
`mongod` binary via `MONGOMS_SYSTEM_BINARY` when present (this dev machine has MongoDB 8.3).

## D-008 · 2026-09-27 · Placeholder license
No license text is invented. `LICENSE` is a clearly marked placeholder until a license is selected.
Superseded by D-022.

## D-009 · 2026-09-27 · Agent adapters are capability-detected, conservative
Adapters only use CLI flags verified against the installed binary's `--help` output or official docs.
Unverified features (e.g. resume for a given agent) are reported as `false` in `capabilities()` and the
runtime falls back to checkpoint-based new-session recovery (§27, §103).

## D-010 · 2026-09-27 · Deterministic mock agent and mock provider ship in-tree
`mock` agent adapter (scriptable scenarios: success, rate limit, context exhaustion, crash, hang,
input request) makes recovery/chaos behaviour testable without paid AI usage. It is flagged
experimental and disabled in production configs unless explicitly enabled.

## D-011 · 2026-09-27 · Worker runs as the developer's user, with per-user autostart
Spec §11 names Windows Service / launchd / systemd. A system-account service cannot use the developer's
agent logins (for example a Claude subscription stored in the user profile), Git credentials, SSH keys or
repository permissions. The installers therefore use per-user autostart: a logon Scheduled Task (Windows),
a LaunchAgent (macOS) and a systemd *user* unit (Linux, with optional `loginctl enable-linger` so it runs
without an active login). A machine-wide service for headless build servers is a future option.

## D-012 · 2026-09-27 · Workspace packages export TypeScript source; apps are bundled with tsup
Internal packages point `exports` at `src/*.ts`. Vitest and tsx run them directly, and tsup bundles
`@ao/*` into each app while keeping third-party packages external (some, such as BullMQ, load files
relative to their own directory and break when bundled). This avoids a build step per package.

## D-013 · 2026-09-27 · Web session: access token in memory, refresh token in an httpOnly cookie
The web app keeps the 15-minute access token in memory only. The refresh token is an httpOnly,
SameSite=Strict cookie scoped to `/api/v1/auth`, accepted only together with the `x-client: web` header,
which cross-site requests cannot send without a CORS preflight. CLI and mobile clients receive the refresh
token in the body and keep it in the OS keychain. A missing session on refresh returns 204, not 401.

## D-014 · 2026-09-27 · Deployed packages use a hoisted node_modules
`pnpm deploy` normally produces a symlinked `node_modules`. Copying that tree (installers use
robocopy/rsync) dereferences the links, and packages lose their sibling dependencies; the installer test
found this. Deploys use `--config.node-linker=hoisted`, which gives a flat tree that is safe to copy on
every OS and in Docker.

## D-015 · 2026-09-27 · Agent and provider limits are reserved when a task starts on a target
The worker, not the control plane, chooses the agent/provider/model after claiming (it knows its own
inventory, limits and fallbacks). Per-agent and per-provider limits are therefore enforced when a worker
reports a new target: the transition to that target first reserves a slot in a `ConcurrencySlot` document
with a conditional update, and is rejected with `CONCURRENCY_LIMIT` if the slot is full. The worker then
tries another compatible target, or returns the task to the queue. The organization limit uses the same
slots at claim time. The scheduler reads the slots to skip workers whose only targets are saturated, so a
rejection is the exception (a race), not the normal path. As with project slots, the reconcile sweep
removes holders that no longer hold a lease.

## D-016 · 2026-09-27 · OAuth sign-in hands the browser a ticket, not a session
The provider callback does not create a session. It stores a random single-use ticket (2 minutes, at most
5 attempts) and redirects to the web app with the ticket in the URL fragment, which browsers never send to
servers or in `Referer`. The web app exchanges it with `POST /auth/oauth/complete`, which runs the same
final checks as password sign-in, including two-factor authentication, before issuing the session.
So signing in through a provider cannot bypass 2FA, and session cookies are only ever set by a same-site
XHR, as for password sign-in (D-013). Identities are matched by provider subject. A verified email may
connect an identity to an existing account; unverified emails never do.

## D-017 · 2026-09-27 · Worker self-update: versioned folders, a stable launcher, confirm-or-roll-back
The OS autostart entry runs `launcher.js` (Node built-ins only), not the worker. Each version is a
complete package in `app/<version>/`, and `state.json` names the current and previous versions, a
pending update and versions that failed. Installing an update unpacks it into a new folder (never over
the running one), marks it current and pending, and the worker exits with code 75 once idle; the
launcher then starts the new version. The new version confirms itself when it is running. If it exits
or hangs before confirming, the launcher restores the previous version and marks the new one bad, so a
broken release can't take a worker down permanently. Packages are unpacked with node-tar (Windows'
bundled bsdtar crashed on real packages), which rejects absolute and `..` paths.

## D-018 · 2026-09-28 · Settings from the dashboard: environment wins, applied in place
Settings that are safe to change while running (registration, sessions, CORS, rate limits, SMTP,
sign-in providers, error tracking, push/telemetry) can be saved in the dashboard. They live in one
versioned document in the `settings` collection, written with compare-and-set so concurrent saves never
lose a change; secrets and URLs that may carry passwords are encrypted with `ENCRYPTION_KEY`. An
environment variable always takes precedence and locks the setting, so deployments managed through
configuration files (Helm values, `.env`) stay authoritative. Saved values are validated with the same
Zod rules and written into the shared `config` object, which services read on every use; the few
objects built from configuration (SMTP transport, error reporter) are rebuilt on change. CORS and rate
limits read the value per request. Each API instance reloads the document every 10 seconds. Bootstrap
settings (database, Redis, keys, ports, storage, `PUBLIC_URL`) remain environment-only.
Feature flags use the same kind of document: platform value plus per-organization overrides, evaluated
from memory; `FEATURE_FLAGS` forces a flag on.

## D-019 · 2026-09-28 · Plugins run on workers in a Node.js permission-model process
Plugin code runs where the task runs (the worker), never in the control plane, so a plugin can't reach
other organizations' data. Each hook starts a fresh `node --permission` process with file-system grants
derived from the manifest's permissions, no child processes, threads or addons unless
`process.execute`/`shell` is granted, an empty environment, `--max-old-space-size` and a timeout. Node 22
has no network permission, so a bootstrap locks every network entry point (`net`, `tls`, `http(s)`,
`http2`, `dgram`, `dns`, `fetch`, `WebSocket`) before the plugin loads; `process.binding` is already
denied by the permission model, so the originals can't be recovered. Code travels inside the immutable
manifest version, pinned by a SHA-256 computed at registration. Plugin failures never fail a task; only
checks a plugin returns can, through the normal verification and remediation loop. Execution is behind
the `plugins.execution` feature flag (off by default) and a worker-level switch.

## D-020 · 2026-09-28 · Agent sandbox: read-everything, write-little, off by default
Agents need the machine's toolchains, so the sandbox keeps the file system readable and restricts
writes (project, temp, the agent's own state folders) and reads of credential folders and the worker's
data. Linux uses bubblewrap (unprivileged user namespaces, no setuid helper of ours); macOS uses
`sandbox-exec` with a generated profile, which is deprecated by Apple but still shipped and used by
other agent tools. Windows has no equivalent that works without administrator rights (AppContainer
needs a native helper), so it reports none. The sandbox is off by default because it couldn't be
exercised on real Linux or macOS here, and a wrong writable list would break agents; organizations
turn it on with `preferred` or `required`, and workers that have one advertise `os-sandbox`.

## D-021 · 2026-10-06 · Desktop app: a Tauri shell around the unchanged worker, with Node.js as a sidecar
The desktop app (`apps/desktop`) does not reimplement the worker. It ships the official Node.js binary
(pinned by checksum, as the sidecar `ao-node`) and the same worker package the releases publish, installs
that package into the D-017 layout in its own data folder, and starts the worker's launcher. Its window
shows the worker's own local UI from `http://127.0.0.1:<port>`; the shell adds a start screen, a tray icon,
start at login, notifications, a folder chooser and a log window. Tauri rather than Electron for the small
shell; the cost is a Rust toolchain for this one app, which is why the package has no `build` script and
the normal CI does not touch it.
- **Two update paths.** The worker inside keeps updating itself through signed releases (D-017), so the
  dashboard's "update workers" covers desktop workers. The shell updates through `tauri-plugin-updater`
  with its own key, and installs its bundled worker only when that is newer than the installed one.
- **Access for the worker UI.** The page is served by the worker, so for Tauri it is a remote origin. The
  app's commands are listed in `build.rs`, which turns on access control for them; the capability
  `worker-ui` grants `http://127.0.0.1:*` six commands (folder chooser, start at login read and write,
  log window, check for app updates, open a link in the browser). The window refuses to navigate anywhere else and hands such links to the browser.
- **Stopping.** A process without a console cannot be sent a signal on Windows, so the worker has
  `POST /api/shutdown`, present only when the app started it (`AO_DESKTOP=1`) and behind the local token.
  The launcher also stops when the app's process is gone (`AO_SUPERVISOR_PID`), so a crashed app leaves
  no worker holding the port.
- **One worker package for every OS.** The package now carries the keyring binaries of all supported
  systems (`scripts/package-worker.mjs`). Before, it had the build machine's only: a package built on
  Linux made Windows and macOS workers fall back to the encrypted-file credential store. A worker that
  did so copies its credentials to the OS store once, on its first start with a working OS store.

## D-022 · 2026-10-07 · License: Apache 2.0 with additional conditions
`LICENSE` is the Agent Orchestration License: the Apache License 2.0 plus conditions set by the owner.
- **Free:** use inside an organization (commercial use included), self-hosting, client work where clients
  receive only deliverables, and publishing a fork's source under the same license.
- **Commercial license needed:** offering the software to outside parties as a hosted or managed service,
  letting outside parties sign in to or work with an instance, and selling or distributing a product that
  includes the software.
- **No branding condition.** Only the notice rules of Apache 2.0 apply.
- **Contributions** come in under Apache 2.0, and the owner may also license them commercially.
- **Wording:** the conditions restrict fields of use, so the project is "source-available", not "open
  source".
- **No enforcement in code.** There is still no license key, license server or usage limit.
