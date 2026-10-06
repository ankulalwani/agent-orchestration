# Implementation Status

States: NOT_STARTED · IN_PROGRESS · PARTIAL · COMPLETE · BLOCKED · DEFERRED · FAILED.
COMPLETE means implemented, integrated, tested, verified and documented (spec §137).
**Evidence** names the tests or manual verification behind each status. Paths are relative to the repository root.

Last full refresh: 2026-09-28.
- Test suite: **391 tests in 60 files, all passing** (5 are opt-in: 4 real-agent-CLI tests and the live Claude Code task; the VS Code host test runs with `pnpm --filter agent-orchestration-vscode test:vscode`) (`npx vitest run`: unit, integration on MongoDB 8.3, end-to-end, chaos, and Playwright/Chromium browser tests).
- Manual verification: separately started `mongod` + API + worker + CLI processes, and the production API bundle run with plain `node`.

## CORE — repository & foundation
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| CORE-001 | pnpm + Turborepo + TypeScript monorepo | 16,69 | COMPLETE | Workspace typechecks; tsup bundles verified |
| CORE-002 | Shared API contracts (Zod + TS) | 71 | COMPLETE | `packages/contracts`, used by API, web, mobile, worker, CLI |
| CORE-003 | OpenAPI generated from contracts | 71 | COMPLETE | `apps/api/src/openapi.ts`; `tests/integration/api.test.ts` |
| CORE-004 | Structured errors | 112 | COMPLETE | `errors.ts`; `redact.test.ts`; API error-shape assertions |
| CORE-005 | Correlation IDs | 113 | COMPLETE | Task `correlationId` on every server and worker event (claim, agent, commands, verification, git); `x-correlation-id` on HTTP |
| CORE-006 | Configurable policies | 104 | COMPLETE | Layered policy platform→org→project→worker→task; `selection.test.ts` |
| CORE-007 | Structured, redacting logs | 61,59 | COMPLETE | `logger.ts` |
| CORE-008 | Idempotency | 105 | COMPLETE | Task keys, transitionIds, eventIds, pairing mint-once (tests) |
| CORE-009 | Durable event model | 106 | COMPLETE | `TaskEvent`; timeline asserted in e2e |
| CORE-010 | Feature flags | 124 | COMPLETE | Declared flags (`packages/core/src/features.ts`); platform administrators turn them on or off for everyone, with per-organization exceptions (**Feature flags** page); `FEATURE_FLAGS` env forces a flag on; evaluated synchronously from memory, other instances converge within 10 s; audited (`server-settings.test.ts`, browser test) |
| CORE-011 | Data retention | 126 | COMPLETE | `retention.ts` hourly purge; `tests/integration/retention.test.ts` (active tasks never purged) |
| CORE-012 | Pagination / indexes | 109 | COMPLETE | Cursor APIs; indexes created on start |

## DB
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| DB-001 | Mongo models for §17 entities | 17 | COMPLETE | `models.ts` |
| DB-002 | Indexes | 109 | COMPLETE | `db-smoke.test.ts` unique constraints |
| DB-003 | Redis never sole source of truth | 17 | COMPLETE | D-003; `reconcile()` rebuilds dispatch from Mongo |
| DB-004 | Safe under Mongo/Redis failure | 86 | COMPLETE | MongoDB outage (`chaos.test.ts`: mongod stopped mid-task; API stays up with retryable 500s and `/readyz` 503, worker continues and buffers, task completes after recovery) and Redis death (`redis.test.ts`: nothing hangs, running task finishes, work created during the outage is dispatched after Redis returns empty) |
| DB-005 | Migrations and seeds | 69 | COMPLETE | Migration runner with lock (`migrations.test.ts`); `seed-demo` command for a new installation (administrator, organization, example project and skill; refuses a database with users) (`seed.test.ts`, run as a real process) |

## AUTH / ORG
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| AUTH-001 | Email/password, hashed | 56 | COMPLETE | scrypt; lockout; tests |
| AUTH-002 | Refresh rotation + reuse detection | 56 | COMPLETE | tests; web httpOnly cookie |
| AUTH-003 | Password reset | 56 | COMPLETE | tests |
| AUTH-004 | Email verification | 56 | COMPLETE | `email-verification.test.ts` |
| AUTH-005 | MFA / OAuth | 56 | COMPLETE | TOTP two-factor: QR enrolment, recovery codes, single-use codes, lockout; web/CLI/mobile (`totp.test.ts` RFC vectors, `mfa.test.ts`). Administrators can turn it off for someone who lost their device: platform administrators for anyone (**Server → Users**), organization owners/admins only for members of their organization alone and not above their role; with a reason, sign-out everywhere, an email and an audit entry (`mfa-reset.test.ts`, mutation-checked; browser test). OAuth/OIDC sign-in for Google, GitHub and any OIDC provider: PKCE, state, nonce, JWKS-verified ID tokens, 2FA still enforced, account linking, invitations (D-016; `oauth.test.ts` against a local fake provider, mutation-checked; browser test). The CLI and the mobile app sign in through the web app with a device code (so SSO and two-factor apply): `device-login.test.ts` (approval, single use, denial, expiry, no API-token approvals, the real `agentctl login` as a process), browser test; mobile typechecked and bundled. Not tried with real Google/GitHub accounts |
| AUTH-007 | Personal API tokens (scripts, CI, IDE) | 56 | COMPLETE | One organization, role capped at the owner's current role, expiry, revocation, hashed; not usable for token management, 2FA or server administration (`api-tokens.test.ts`, mutation-checked; browser test); CLI `AO_TOKEN` |
| AUTH-006 | Device/worker authentication | 56,13 | COMPLETE | Pairing e2e (API, CLI, browser) |
| ORG-001..004 | Orgs, roles, tenant isolation, API-level RBAC | 18,57 | COMPLETE | Isolation and RBAC tests, including artifacts and approvals |
| ORG-005 | Invitations for people without an account | 18 | COMPLETE | Emailed single-use link (hashed token, 7 days, re-invite replaces it); register through it even with registration closed, or accept while signed in; revoke; `invitations.test.ts` (including concurrent use, mutation-checked) and a browser test of the full flow |

## SECURITY
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| SEC-001..006 | Validation, headers/CORS/rate limits, CSRF, no shell injection, path isolation, redaction | 58,59,114–116 | COMPLETE | `api.test.ts`, `misc.test.ts`, `redact.test.ts`, `agents.test.ts` |
| SEC-007 | Encrypted control-plane secrets | 59 | COMPLETE | AES-256-GCM with a key id per value; rotation via `ENCRYPTION_KEYS_PREVIOUS`, background re-encryption at startup and a `reencrypt-secrets` command (`crypto.test.ts`, `key-rotation.test.ts`; command run against a real `mongod`, including the failure path) |
| SEC-008 | Worker secrets in OS store | 13,59 | COMPLETE | Windows Credential Manager verified; encrypted-file fallback tested |
| SEC-009 | Masked provider credentials | 120 | COMPLETE | Worker UI browser test asserts only the masked key appears |
| SEC-010 | Immutable audit log | 60 | COMPLETE | `db-smoke.test.ts`, `retention.test.ts` |
| SEC-011 | Worker UI loopback-only | 12 | COMPLETE | Token + Host check + no CORS (`worker.test.ts`, browser test) |
| SEC-012 | No phone-home; telemetry opt-in | 127,128 | COMPLETE | No default outbound calls |
| SEC-013 | Agent env allowlist | 114 | COMPLETE | `agents.test.ts` |
| SEC-014 | OS-level sandbox for agents | 114 | PARTIAL | Policy `sandbox` (off / preferred / required; network; extra writable/hidden paths): bubblewrap on Linux, `sandbox-exec` on macOS; project, temp and agent state writable; credential folders and the worker's data hidden; `os-sandbox` tool tag; `required` without one → RECOVERY_REQUIRED. `sandbox.test.ts` (generated bwrap arguments and Seatbelt profile), `worker-flow.test.ts` (task run through a stand-in bwrap; required without a sandbox). Not run on Linux or macOS (unavailable here); no Windows sandbox |

## TASK
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| TASK-001,002 | Task model; explicit state machine | 20,21 | COMPLETE | tests |
| TASK-003 | Queue with priorities/delays | 22 | COMPLETE | Memory driver and BullMQ driver tested; BullMQ against real Redis 8.10 (`bullmq.test.ts`: delivery, dedupe, aged priority order, delays, fail-fast while Redis is down). Redis ran as a Windows build (redis-windows), not on Linux |
| TASK-004 | Starvation prevention | 22 | COMPLETE | Dispatch queue orders by aged effective priority (`queue.test.ts`); freed slots, the reconcile sweep and worker offers all go highest-effective-priority first. BullMQ applies aging as of enqueue time (driver UNVERIFIED, see TASK-003) |
| TASK-005,006 | Atomic claim; lease recovery without duplicates | 23 | COMPLETE | 5-claimant race (mutation-checked), fencing, chaos takeover |
| TASK-007 | Dependencies | 24 | COMPLETE | tests |
| TASK-008 | Agent-neutral wrapper | 25 | COMPLETE | test |
| TASK-009 | Concurrency limits | 19,46 | COMPLETE | Project and organization slots reserved atomically at claim; agent and provider slots reserved atomically when a task starts on a target, with dispatch steering away from saturated ones (D-015). `task-engine.test.ts` (races, mutation-checked), `selection.test.ts`, e2e worker fallback on a full provider |
| TASK-010..012 | Worker / agent / model selection | 47–49 | COMPLETE | `selection.test.ts`; e2e |
| TASK-013 | Pause/resume/cancel/retry/restart/input/approve | 83 | COMPLETE | e2e: pause/resume, approve/deny, input, cancel; retry in integration |
| TASK-014..016 | Input persisted; completion report; timeline | 84,45,106 | COMPLETE | e2e |

## AGENT
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| AGENT-001..004 | Interface, states, runtime, detection | 7,8,103 | COMPLETE | `agents.test.ts` |
| AGENT-005 | Claude Code adapter | 4 | COMPLETE | Flags and stream-json verified on 2.1.281; a real coding task run end to end on 2026-09-28 (control plane + worker + Claude Code with its subscription login, Haiku 4.5): bug found and fixed, worker verification passed, commit on the task branch; session id, tool calls, usage/cost (US$0.06), rate-limit warnings and the agent's report parsed (`claude-code-live.test.ts`, opt-in `AO_TEST_CLAUDE_LIVE=1`) |
| AGENT-006..009 | Codex, Gemini CLI, OpenCode, Aider | 4 | PARTIAL | Verified against the real binaries (codex-cli 0.157.1, Gemini CLI 0.61.0, OpenCode 1.18.32, Aider 0.86.2): flags, output formats and failure classification, run through the real session runtime (`agent-clis.test.ts`, fixtures in `adapters/fixtures`). Fixed: Codex `--full-auto` rejected, Gemini YOLO ignored in untrusted folders, Aider exit 0 on failure and repo side effects. No successful task yet (needs accounts) |
| AGENT-012 | Cursor Agent, Copilot CLI, Kiro, Qwen Code, Kimi Code, Grok, Trae Agent, Amp, Factory Droid, Auggie, Crush, Cline, Kilo Code, Pi, Continue, Qoder, CodeBuddy, Mistral Vibe | 4 | PARTIAL | 2026-10-06, `adapters/more-adapters.ts`. Verified against the real binaries (Kiro 2.27.1 in a Linux container): `--help`, and a run without credentials through the real session runtime (`agent-clis.test.ts`, fixtures in `adapters/fixtures`). Copilot CLI, Qwen Code, Kilo Code, Pi, Crush and Trae Agent completed a task through the model gateway against a fake model (`gateway-agents.test.ts`). Direct providers run with the real CLIs (`direct-providers.test.ts`, 29 routes); that found and fixed wrong routes of Codex, OpenCode and Aider too. No run with a vendor account yet; no resume |
| AGENT-010,011 | Mock adapter; limit/context/crash/auth detection | 7,28 | COMPLETE | tests |

## PROVIDER
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| PROV-001,004,005,007,008 | Interface, multi-provider, health/models/usage, usage tracking, safe polling | 5,6,50,108 | COMPLETE | `providers.test.ts`; e2e usage assertion |
| PROV-002 | Anthropic, OpenAI, Google, OpenRouter, Azure, Ollama, OpenAI-compatible | 5,6 | PARTIAL | Tested against an HTTP fake; no live APIs |
| PROV-003 | Bedrock / Vertex | 5 | PARTIAL | Health checks built: Bedrock SigV4-signed `ListFoundationModels` (also the model list), Vertex OAuth token + project location check; credential resolution from worker store, env and profile/ADC files; agents get the credentials (`cloud.test.ts`: official AWS SigV4 vector, AWS SDK signer comparison, fakes that verify signatures). Not tried against live AWS / Google Cloud |
| PROV-006 | Keys / base URL / agent login / OAuth | 6 | COMPLETE | Keys, base URLs, agent login, cloud credentials (PROV-003) and OAuth sign-in where a provider offers it for API access: OpenRouter PKCE through the worker's loopback UI, single-use expiring state, key stored in the credential store (`provider-oauth.test.ts` against a fake that verifies the PKCE challenge). Not tried against openrouter.ai itself |

## RECOVERY
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| REC-001..008 | Checkpoints, context reset, limits, fallback, crash, hang, worker loss | 9,23,26–31 | COMPLETE | `tests/e2e/worker-flow.test.ts`, `task-engine.test.ts`, `agents.test.ts` |
| REC-009 | Network failure: continue, buffer, resync | 85,107 | COMPLETE | `tests/chaos/chaos.test.ts` control-plane outage |

## WORKER
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| WORKER-001,003,004,005 | Native process, startup order, local API + UI | 10–12,51,52 | COMPLETE | Packaged worker run; UI browser test |
| WORKER-002 | Auto-start | 11 | PARTIAL | Per-user Scheduled Task / LaunchAgent / systemd user unit (D-011). Windows verified for real on 2026-09-28: task registered and started, worker served the local UI; a killed worker process was restarted by the launcher at once, a killed launcher by the task's every-minute trigger within 51 s (fix: Task Scheduler's restart-on-failure does not cover processes that die); uninstall left nothing behind. The logon trigger itself (sign out/in) and macOS/Linux were not exercised |
| WORKER-006..011 | Hosted/self-hosted choice, pairing, connection, buffer, metrics, project mapping | 12–14,107,115 | COMPLETE | e2e, chaos, browser |
| WORKER-012 | Signed auto-update | 66 | COMPLETE | Built: Ed25519-signed manifest, SHA-256 package check, versioned install with a launcher, drain → restart → self-confirm, automatic rollback on crash or hang, manual or automatic policy (D-017; `updater.test.ts`, `worker-update.test.ts` with real processes and a path-traversal package). Verified end to end with the real packaged worker and Windows installer (0.1.0 → signed 0.1.1 from a local server → confirmed; worker stops when its launcher is killed). Release hosting: the control plane hosts signed releases (admin upload of package + offline-signed manifest, checked against the package and URL; public manifest/package endpoints; workers default to their control plane as source while trust stays in locally configured keys; **Server → Worker releases**, worker UI trusted keys) (`worker-releases.test.ts`: publish, fetch and verify with the worker's Updater, untrusted signature refused). Each operator generates their own release key |
| WORKER-013 | Installers | 65 | PARTIAL | Windows installer and uninstaller run for real (scheduled task, start, `agentctl doctor`, restart, complete removal incl. data and Credential Manager entries). macOS/Linux scripts pass shellcheck but have not run on those systems |
| WORKER-014 | Desktop app | 11,12,65 | PARTIAL | `apps/desktop` (D-021): Tauri shell with Node.js and the worker package inside; start screen, tray, start at login, notifications, folder chooser, log window, takeover of a command-line worker, own signed updates. Shell: 16 Rust unit tests on Windows and Linux; scripts and the worker's part in `desktop.test.ts`, `worker-update.test.ts`, the worker UI browser test (with a stand-in for the app). Run for real on Windows 11 (locally built installer: install, pair, takeover, update, refused bad signature, uninstall) and in an Ubuntu 22.04 container (`.deb`, `.AppImage`). Open: macOS never built or run; installers unsigned; release workflow not run yet; tray menu and notifications not driven by a test |

## CAPABILITIES
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| CAP-001..004,006..009,013 | Types, registry, scopes, manifest, install policy, trust, permissions, private, skills | 32–40,119 | COMPLETE | Core tests + dashboard |
| CAP-005 | Capability planner / task analyzer | 36 | COMPLETE | Readiness analyzer on repository facts + per-agent MCP/skill plan (`readiness.test.ts`, e2e) |
| CAP-010 | AI readiness | 41 | COMPLETE | Worker facts → control-plane report; e2e; dashboard card |
| CAP-011 | MCP security | 117 | COMPLETE | Registered, scoped, permissioned, secret refs; health checks with the real MCP handshake over stdio / Streamable HTTP / SSE (`mcp-health.test.ts` against servers built with the official SDK, incl. crashing, hung and non-MCP endpoints); only healthy worker servers are advertised; unhealthy capability servers are withheld from agents (e2e, mutation-checked; worker UI browser test) |
| CAP-012 | Plugins | 118 | COMPLETE | Hooks `task.prepare` (prompt instructions), `task.verify` (required checks that trigger remediation), `task.completed`; each run in a new Node.js process under the permission model (file system per declared permission, no child processes/threads/addons/`process.binding`, in-process network block, empty environment, time and memory limits); code pinned by SHA-256; secret configuration resolved only with `secrets.read` and audited; gated by the `plugins.execution` feature flag and a worker-level switch. `plugins.test.ts` (escape attempts for files, network, processes, environment; limits; mutation-checked), `worker-flow.test.ts` (flag off → skipped, no secret sent; flag on → remediation from a plugin check, prompt instructions, timeline logs; mutation-checked) |

## GIT / VERIFY
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| GIT-001..003,005 | Operations, policies, destructive guard, preserve user work | 42 | COMPLETE | `git.test.ts` (including push to a bare remote); e2e commits |
| GIT-004 | Pull requests | 42 | COMPLETE | GitHub pull requests and GitLab merge requests through the REST API with a per-host token in the worker's credential store (remote parsed from https/ssh/scp URLs; GitHub Enterprise and self-managed GitLab via API URL), `gh` as fallback; failures reported without undoing commit/push (`git.test.ts` with a real bare remote and a fake API, `worker-flow.test.ts` end to end, `worker.test.ts`). Not tried against github.com/gitlab.com; the `gh` path is unverified |
| VERIFY-001,003 | Checks, auto-remediation | 43,44 | COMPLETE | tests, e2e |
| VERIFY-002 | Playwright browser verification | 43,76 | COMPLETE | `tests/e2e/browser-verification.test.ts` (real Chromium, console error caught, screenshot) |
| VERIFY-004 | Artifacts in object storage | 62 | COMPLETE | Filesystem driver tested end to end; S3 driver tested against a real S3-compatible server (SeaweedFS 4.47, `s3.test.ts`: worker upload → bucket → user download; bad credentials fail loudly). Not tried against AWS itself |

## WEB / MOBILE / NOTIFY / OBS / STORAGE
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| WEB-001..008 | Dashboard, task detail, live updates, management pages, onboarding, responsive | 10,54,79–83,110 | COMPLETE | `tests/e2e/web.test.ts` (Chromium: full flow, live completion, no console errors, 390 px width); screenshots reviewed |
| MOBILE-001..003 | Expo app, screens, RBAC-aware actions | 53,111 | PARTIAL | Typecheck, expo-doctor 21/21, Metro production bundles for Android and iOS. Covers the newer features too: task type and source (integration link, parent plan), review results, plans with **Create N tasks**, browser sign-in (SSO). Not run on a device or emulator |
| MOBILE-004 / NOTIFY-003 | Push notifications | 53,55 | PARTIAL | Client registration + server Expo push (opt-in); needs an EAS project id; UNVERIFIED |
| NOTIFY-001 | In-app | 55 | COMPLETE | |
| NOTIFY-002 | Email | 55 | COMPLETE | Real SMTP delivery with authentication via nodemailer against a local SMTP server (`smtp.test.ts`); a mail outage no longer fails registration/invitations/password reset. Not tried with a hosted mail provider |
| OBS-001,002 | Health, Prometheus metrics | 61 | COMPLETE | tests |
| OBS-003 | Error-tracking hooks | 61 | COMPLETE | Opt-in reporter (Sentry-compatible DSN without an SDK, JSON webhook, in-process listeners) for API 5xx, crashes, scheduler and worker task errors; redacted and rate-limited (`error-reporting.test.ts` against a local collector, `error-tracking.test.ts` through the API; crash reporting checked in a real child process). Not tested against a hosted Sentry |
| STORE-001 | S3-compatible storage | 62 | COMPLETE | See VERIFY-004 |
| LIVE-001 | Multi-instance live fan-out | 54 | COMPLETE | Two real API instances on Redis (`redis.test.ts`): dispatch across instances, live updates and task control relayed through pub/sub; worker presence synced on start-up and expired for crashed instances (mutation-checked) |

## DEPLOY / SELFHOST / CLI / EXTENSIBILITY
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| DEPLOY-001 | Docker, Compose, .env.example | 63 | COMPLETE | Run on 2026-09-28 with Docker Desktop (Engine 29.8, WSL 2): image builds (428 MB, production dependencies from the lockfile), Compose starts healthy control plane + MongoDB 7 + Redis 7; dashboard and API served; a host worker paired and completed a task (BullMQ dispatch, verification, commit, artifact upload/download); data and artifacts survive recreating containers; `seed-demo`/`reencrypt-secrets` in the container. Production file with Caddy (`DOMAIN=localhost`): HTTPS, HTTP→HTTPS redirect, port 4000 closed, WebSocket through the proxy. Fixed on the way: artifact folder not writable and not on a volume; lockfile ignored by `pnpm deploy`; 3 GB of local tooling sent as build context. Dockerfile passes hadolint |
| DEPLOY-002 | Terraform / Helm | 64 | COMPLETE | Helm chart passes `helm lint --strict` and kubeconform, and was installed on 2026-09-28 on Docker Desktop's Kubernetes (v1.36) with MongoDB and Redis in the cluster: autoscaler raised the deployment to its minimum of 2, both replicas ready on shared MongoDB/Redis, dashboard and API through the Service, PodDisruptionBudget, a manually triggered backup job wrote a dump to the backup volume that restored into a check database, ServiceMonitor and PrometheusRule accepted by the real Prometheus Operator CRDs. Terraform module (`deployment/terraform/kubernetes`) planned and applied on the same cluster (namespace, generated secrets, release with backups and monitoring; instance ready), its Redis precondition refuses 2 replicas without Redis, then destroyed. Not tried on a managed cloud cluster; no EKS/GKE/AKS cluster provisioning |
| DEPLOY-003 | Backup/restore | 125 | COMPLETE | Drill automated with MongoDB Database Tools 100.19.0 (`backup-restore.test.ts`): dump → separate-database check → drop → restore → restart; sign-in incl. 2FA, secrets, indexes, timelines, counts and lease recovery verified. The Docker Compose form of the documented commands also run on 2026-09-28: backup → change → `--drop` restore → the change is gone, sign-in works, server stays ready |
| SELFHOST-001 | No artificial limits | 2.1 | COMPLETE | `extension-contract.test.ts` asserts the self-hosted API is ungated |
| SELFHOST-002 | Admin-configurable infrastructure | 122 | COMPLETE | **Server settings** page for platform administrators: every setting with its source, secrets only as set/not set, URL passwords masked, live status. Registration, sessions, CORS, rate limits, SMTP, sign-in providers, error tracking and push/telemetry can be changed there without a restart. Environment variables win and lock the setting; secrets are encrypted and included in key rotation; values validated; changes audited without values; other instances converge within 10 s. `server-settings.test.ts` (switching to a real SMTP server, error webhook on/off, rate limit, CORS, second instance, concurrent saves, key rotation; mutation-checked), `admin-server.test.ts`, browser test. Database, keys, storage and ports stay environment-only (read at startup) |
| CLI-001,002 | `agentctl`, `doctor` | 67,68 | COMPLETE | Real-process smoke run |
| EXT-001 | Composition without divergence | 70 | COMPLETE | `ControlPlaneExtension` + `startControlPlane` (`apps/api`); contract tested in `extension-contract.test.ts`; `scripts/check-boundary.mjs` in CI |

## FUTURE (V1.5+, spec §129: not required for V1)
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| FUT-001 | AI Project Manager | 73 | COMPLETE | Plan tasks (`kind: plan`): the agent studies the repository in a read-only worktree and proposes up to 30 self-contained tasks with dependencies; the plan is validated (schema, unknown dependencies, cycles, no file changes) with remediation; a person applies it to create the tasks in dependency order (idempotent, concurrent-safe, audited); web, CLI, API (`worker-flow.test.ts`, `task-engine.test.ts`, browser test). Not tried with a real agent |
| FUT-002 | Integration-driven task creation | 74 | COMPLETE | Webhook integrations: GitHub (issues by label, `/agent` comments; X-Hub-Signature-256), GitLab (issue hooks, notes; X-Gitlab-Token), generic JSON (HMAC, templates, delivery id); idempotent per external item; replies as issue comments or a signed callback on created/completed/failed/needs attention; secret rotation; audit (`integrations.test.ts` against a fake GitHub/GitLab API, signature check mutation-checked; browser test). Not tried with github.com or gitlab.com |
| FUT-003 | PR review agents | 75 | COMPLETE | Review tasks (`kind: review`): refs resolved and fetched (pull/merge request heads), a separate worktree so the user's checkout is untouched, the diff in an agent-neutral review prompt, review JSON validated, file changes refused and discarded with remediation; from integrations for GitHub pull requests and GitLab merge requests (opened / every push, drafts skipped), posted back as a PR review with line comments (always a comment; body-only fallback on 422) or an MR note; web and CLI (`worker-flow.test.ts` with the mock agent in a real repository; `integrations.test.ts` against fake GitHub/GitLab APIs). Not tried with a real agent or github.com |
| FUT-004 | QA agent flow | 76 | COMPLETE | Browser/smoke steps can start the app and stop it afterwards; `discover` visits linked pages, configured paths and routes from file-based routers (Next.js, Nuxt, SvelteKit, Remix, Astro), reporting each broken page with screenshots (`qa-discovery.test.ts` in real Chromium, `routes.test.ts`). No form filling or signed-in crawling |
| FUT-005 | Project knowledge | 77 | COMPLETE | Organization, project and task knowledge, each under its own heading in the prompt's Knowledge section, also after a worker restart (`task-engine.test.ts`, `misc.test.ts`); web (Settings, project page, New task) and CLI (`--knowledge-file`) |
| FUT-006 | Environment profiles | 78 | COMPLETE | A task's environment profile reaches the worker with its variables and resolved secret values (audited), as environment variables of the agent and the verification steps; values are scrubbed from recorded output; a missing secret stops the task; per-environment approval (`worker-flow.test.ts`: approval, agent and verification see the values, scrubbing mutation-checked, missing secret) |
| FUT-007 | IDE/extension entry points | 87 | COMPLETE | VS Code extension (`apps/vscode`): sign in with an API token (secret storage), create a task from a selection (code, file and lines in the prompt) or free text, review the current branch, Explorer task list with status and attention states, links to the dashboard; commands tested against a real control plane (`vscode-extension.test.ts`); activation and command registration verified in VS Code 1.139.1 (`pnpm --filter agent-orchestration-vscode test:vscode`, opt-in); packaged with `vsce`. Not published to the Marketplace; no JetBrains plugin |

## OPERATIONS AND GROWTH (added 2026-10-05)
None of these were tried against the real external services; each names what stood in for them.

| ID | Feature | Status | Evidence / notes |
|---|---|---|---|
| OPS-001 | Spend budgets | COMPLETE | USD and token limits per task, per project and per organization (calendar month, UTC) in the execution policy; a task stops with RECOVERY_REQUIRED before its next agent session, queued tasks wait, one warning and one "reached" notice per month; narrower layers cannot raise wider limits (`budget.test.ts`, browser test). Spend is known when a session ends, so one session can overshoot |
| OPS-002 | Scheduled tasks | COMPLETE | Cron expressions in an IANA time zone (own parser: `cron.test.ts`, incl. daylight-saving changes), overlap skip, run now, one task per run across instances, tasks on behalf of the creator (`schedules.test.ts`, browser test) |
| OPS-003 | Chat channels | COMPLETE | Notifications to Slack and Microsoft Teams (incoming webhooks); Slack buttons and a slash command checked against Slack's signature, run with the member's role by linked Slack member ID (`chat.test.ts` against a local fake of Slack and Teams, browser test). Teams is notifications only |
| OPS-004 | Insights | COMPLETE | Five views, each against the previous period: outcomes (success and first-pass rate, cost, time; by agent, model, project), cost (per day, by project/model/agent, most expensive tasks, month-end budget forecast), workers (finished, agent time, time online from heartbeats, utilization), reliability (why tasks stopped, recorded by the code path that stops them; recoveries by agent; verification step failure rates), flow (median and 90th percentile times; by creator, source, kind, priority). CSV export of every table, weekly digest by email and chat, `agentctl insights`, mobile tab (`analytics.test.ts`, `digest.test.ts` with a local fake of the chat webhook; browser run with screenshots of every view, a CSV download and the digest preview) |
| OPS-005 | Several agents on one task | COMPLETE | 2 to 4 attempts, each pinned to an agent; first to pass verification wins, the others are cancelled; a worker runs one attempt of a task at a time (`attempts.test.ts`, browser test). Needs a worker per attempt to run at the same moment |
| OPS-006 | Task templates | COMPLETE | `{{variable}}` placeholders with labels, defaults and optional ones; picker in the New task dialog (`task-templates.test.ts`, browser test) |
| OPS-007 | CI checks as verification | COMPLETE | Waits for GitHub check runs and statuses or GitLab job statuses of the pushed commit; failed checks go back to the agent with the end of the job log; the fix joins the same branch and pull request (`ci.test.ts`; `worker-flow.test.ts` end to end with the mock agent, a real Git remote and a fake GitHub API) |
| OPS-008 | Follow-ups | COMPLETE | A task continues another's branch and pull request, fetching what others pushed; GitHub reviews that request changes, and comment commands on such a pull request, create follow-ups with the review's line comments (`integrations.test.ts` against a fake GitHub API; `worker-flow.test.ts` end to end) |
| OPS-009 | Jira and Linear | COMPLETE | Issues by label and comment commands become tasks; signatures checked (Jira `X-Hub-Signature`, Linear `Linear-Signature` with Linear's own secret); replies as issue comments (`integrations.test.ts` against fakes of both APIs) |
| OPS-010 | Queued clone requests | COMPLETE | A clone asked of an offline worker is kept for 7 days and sent once when it connects (`clone.test.ts`) |
| AUTH-008 | Security keys (WebAuthn) | COMPLETE | Security keys and passkeys as a second step next to authenticator codes; single-use challenges; replayed answers and answers for another origin refused (`web-security-keys.test.ts` in Chromium with its virtual authenticator). Not tried with a physical key |
| ORG-006 | Provisioning (SCIM 2.0) | COMPLETE | Users: create, find, replace, patch (Okta and Entra forms), suspend, remove; per-organization bearer token; suspension applies at once (`scim.test.ts`). Groups are not provisioned; not tried against Okta or Entra |
| CAP-014 | Stacks | COMPLETE | Platform and organization stacks installed in one step under the usual policy; public catalog endpoints (`stacks.test.ts`, browser test). Marketing-site pages are in the site repository. No paid listings |
| CAP-015 | Semantic suggestions | COMPLETE | Optional OpenAI-compatible embeddings API; closeness in meaning adds to the rule-based ranking; falls back to the rules when the API fails (`semantic-suggestions.test.ts` against a fake embeddings API). Not tried with a real model; the Atlas vector-search path is unverified |
| EXT-002 | Task create guard | COMPLETE | `tasks.addCreateGuard` for a distribution's own limits on every way a task is created (`extension-contract.test.ts`) |

## TEST / DOCS / LEGAL
| ID | Requirement | § | Status | Evidence / notes |
|---|---|---|---|---|
| TEST-001 | Unit tests for the §88 list | 88 | COMPLETE | All listed areas covered |
| TEST-002 | Integration tests for the §89 list | 89 | COMPLETE | Including capability readiness and fallback |
| TEST-003 | Chaos tests for the §90 list | 90 | COMPLETE | Control-plane outage, worker death, MongoDB outage, Redis death, and provider credentials expiring mid-task (falls back to another provider from the checkpoint; with no alternative → RECOVERY_REQUIRED with instructions, then a new key + Retry continues from the checkpoint) |
| TEST-004 | Browser E2E | 14 | COMPLETE | Dashboard and worker UI |
| DOC-001,002 | Tracking docs; docs tree | 91,92 | COMPLETE | Reflects the implementation, with verification status stated |
| LEGAL-001 | License decision document | 3 | COMPLETE | |
| LEGAL-002 | Final license | 3 | BLOCKED | Reason: legal decision. Action: counsel selects a license. Workaround: placeholder. Impact: cannot be distributed as licensed software. |

## Blocked items (spec §102)
| Item | Reason | Required action | Workaround | Impact |
|---|---|---|---|---|
| LEGAL-002 | Legal decision | Counsel selects a license | Placeholder LICENSE | No distribution rights granted |
| Successful agent runs (AGENT-006..009) | Needs accounts for Codex, Gemini CLI, OpenCode, Aider | Run one small real task per agent you use (`claude-code-live.test.ts` shows how) | Failure paths verified with the real CLIs; Claude Code verified live | Success-path event parsing of Codex/Gemini/OpenCode is documentation-based |

## Next exact actions
1. Deploy with Docker Compose on a Linux server with a public domain (Let's Encrypt through Caddy); Docker itself is verified on Windows.
2. With your accounts: one small real task each for Codex, Gemini CLI, OpenCode and Aider (Claude Code is done); verify Gemini/OpenCode resume.
3. Maintainers: add the private key of `ao-release-1` as the repository secret `WORKER_RELEASE_SIGNING_KEY`, tag a release, and press **Update workers** (**Server → Worker releases**) on a real server to fetch it.
4. Register real OAuth apps (Google/GitHub/company SSO) and sign in once with each.
5. Point an integration at a real GitHub or GitLab repository (issues, `/agent` comments, pull request reviews), and open a pull request through a worker with a Git hosting token.
6. Turn on the OS sandbox (`sandbox.mode: preferred`) on a Linux or macOS worker and run a task with each agent you use; add any state folders they need to `sandbox.writable`.
7. `terraform apply` the Kubernetes module on a test cluster, with backups and monitoring on; run a restore drill from a backup it made.
