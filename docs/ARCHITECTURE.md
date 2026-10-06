# Architecture

This document describes the architecture as **implemented**. Items not yet built are marked
_(planned)_. See `IMPLEMENTATION_STATUS.md` for per-requirement status.

## 1. System overview

```
             ┌──────────────────────── Control plane (apps/api) ────────────────────────┐
 Web (apps/web) ─HTTPS/WS─►  Auth · Orgs · RBAC · Projects · Workers · Tasks · Events    │
 Mobile (apps/mobile) ────►  Scheduler (lease sweeper, dispatch) · Audit · Notifications │
 CLI (apps/cli) ──────────►  MongoDB (durable truth) · Redis/BullMQ (dispatch signals)   │
             └──────────────────────────────▲───────────────────────────────────────────┘
                                            │ outbound HTTPS + WSS only
             ┌──────────────── Worker (apps/worker, native OS service) ─────────────────┐
             │ Control-plane client · Event buffer · Task executor · Recovery engine    │
             │ Agent manager ─► adapters (claude-code, codex, gemini, cursor, … 23)     │
             │ Provider manager ─► providers (anthropic, openai, google, openrouter,…)  │
             │ Git manager · Verification engine · Credential store · Local API + UI    │
             └──────────────────────────────────────────────────────────────────────────┘
```

## 2. Key principles (enforced in code)

| Principle | Where enforced |
|---|---|
| Agent-agnostic core | `packages/core` has no agent-specific code; agent specifics live only in `packages/agents/src/adapters/*` |
| Agent ≠ provider | Separate `AgentAdapter` (`packages/agents`) and `ModelProvider` (`packages/providers`) interfaces; tasks store `agentId`, `providerId`, `modelId` independently |
| MongoDB is durable truth | Task claims/leases are Mongo atomic `findOneAndUpdate`; the queue only signals |
| Explicit task state machine | `packages/core/src/task-state.ts` — `transition()` rejects undeclared transitions |
| Tenant isolation | Every org-owned query goes through `orgScope()` in `packages/database`; API derives `organizationId` from verified membership, never from the request body |
| No shell interpolation | `packages/core/src/exec.ts` `safeSpawn` uses `spawn(cmd, args, {shell:false})` and validates arguments |
| Secret hygiene | `redact()` in `packages/core/src/redact.ts` applied to logs, events, errors |

## 3. Packages

Consolidated relative to spec §69 (see DECISIONS D-002). Each spec package maps to a module:

| Package | Contains (spec §69 equivalents) |
|---|---|
| `packages/core` | core, task-engine (state machine), scheduler policy (worker/agent/model selection), fallback-engine, dependency graph, capabilities resolution, security (redaction, path guard, safe exec), errors, RBAC |
| `packages/contracts` | api-contracts, worker-protocol (Zod schemas + inferred types) |
| `packages/database` | database, Mongoose schemas, indexes, repositories (atomic claim, leases, events) |
| `packages/agents` | agent-sdk, agent-runtime, agents/* adapters |
| `packages/providers` | model-sdk, model-providers, provider-router, usage-manager |
| `packages/git` | git (safe Git manager) |
| `packages/verification` | verification engine |
| `packages/queue` | queue (BullMQ + in-memory driver) |
| `packages/server` | control-plane services (auth, orgs, projects, workers, tasks, scheduler, capabilities, retention, artifacts, live hub); composition root `createServices` |
| `packages/ui` | shared web UI kit and design tokens (web dashboard, worker UI) |

Apps: `apps/api`, `apps/worker`, `apps/web`, `apps/cli`, `apps/mobile`, `apps/worker-ui` (served by
the worker), `apps/vscode`, `apps/desktop` (a Tauri shell that runs the worker and shows the worker UI
in a window; D-021).

Dependency direction (checked in CI by `scripts/check-boundary.mjs`):

```
core ◄─ contracts, database, git, providers, queue, verification ◄─ agents ◄─ worker ◄─ cli
                         ▲
                      server ◄─ api ◄─ (extensions: routes + hooks via `extend`)
ui ◄─ web, worker-ui          contracts ◄─ mobile
```

### Extension points (spec §70)

The control plane is one implementation. Anything that runs it with extra behaviour (a multi-tenant
distribution, company-specific routes) composes it instead of forking it:

| Extension point | Where | Contract |
|---|---|---|
| `ControlPlaneExtension` | `apps/api/src/app.ts` | `(app, services) => void`; runs after security plugins and before core routes; may add routes and `preHandler` hooks, and may answer a request instead of the core. Tested in `tests/integration/extension-contract.test.ts`. |
| `startControlPlane({ extend, env, name })` | `apps/api/src/server.ts` (`@ao/api/server`) | The one startup sequence: database, services, settings, scheduler, HTTP, key rotation, graceful shutdown. |
| `createServices(config)` | `packages/server` | The service container passed to extensions (auth, orgs, tasks, workers, audit, …). |
| Exported models, `orgScope()` | `packages/database` | Extensions may read core collections and keep their own collections; they never change core schemas. |
| RBAC permissions | `packages/core/src/rbac.ts` | Generic permissions (for example `billing.manage`, owners only) that extensions check with `can()`. |
| `WebExtension` / `renderWebApp()` | `apps/web/src/extension.tsx`, `apps/web/src/app.tsx` | Extra dashboard routes, navigation items and a banner; `apps/web/src/main.tsx` renders the dashboard without one. |
| `organization.notice` | `packages/server/src/notifications.ts` | Generic organization notice; `email: true` also sends it by email. |
| Commands | `apps/api/src/commands.ts` | `platform-admin <email> [--revoke]`, `reencrypt-secrets`, `seed-demo`; reusable by other entry points. |
| `DEPLOYMENT_MODE=cloud` | `packages/server/src/config.ts` | Marks a shared, multi-tenant installation; only changes defaults (`REQUIRE_PUBLIC_CALLBACK_URLS`). |
| `FIRST_USER_IS_PLATFORM_ADMIN` | `packages/server/src/config.ts` | On by default (browser bootstrap); off where the public signs up first. |
| `EXPO_PUBLIC_HOSTED_URL` | `apps/mobile/lib/api.ts` | Presets a default server in a mobile build; otherwise the user enters one. |
| Capability registry | `packages/server/src/capability.service.ts` | Each installation owns its registry; there is no mandatory marketplace. |

The rules for what may and may not live in this repository are in `PUBLIC_PRIVATE_BOUNDARY.md`.

## 4. Task lifecycle

```
QUEUED → CLAIMING → PREPARING → RUNNING → VERIFYING → COMPLETED
                          │         │  ▲         │
                          │         ▼  │         └─► RUNNING (remediation)
                          │   WAITING_FOR_LIMIT / WAITING_FOR_INPUT
                          │         │
                          ▼         ▼
                       CRASHED → RECOVERY_REQUIRED / QUEUED (requeue)
 any non-terminal → CANCELLED ; failures → FAILED
```

The authoritative transition table is `TASK_TRANSITIONS` in `packages/core/src/task-state.ts`.

## 5. Claiming and leases

1. Scheduler (API) selects a candidate worker by policy (`selectWorker`) and pushes an offer over WS.
2. Worker calls `POST /api/v1/worker/tasks/:id/claim`. The API performs one Mongo
   `findOneAndUpdate({_id, status:'QUEUED', deps satisfied}, {status:'CLAIMING', workerId, leaseExpiresAt})`.
   Exactly one claimant can win.
3. The worker renews the lease with every heartbeat. The lease sweeper requeues or marks
   `RECOVERY_REQUIRED` for tasks whose lease expired, per policy.

## 6. Worker ↔ control plane protocol

Outbound WebSocket from worker, authenticated by a worker credential obtained via device-code
pairing. Messages are Zod-validated (`packages/contracts/src/worker-protocol.ts`). Worker events carry
`eventId` + per-worker `sequence`; the API deduplicates by `eventId` (unique index), which makes
replays from the worker's local buffer idempotent.

## 7. Checkpoints

The worker writes `.agent-orchestration/` in the project directory (task-state, checkpoints,
progress, plans, verification, logs, metadata). Checkpoints are also sent to the control plane
as `CheckpointCreated` events. This directory is added to the project's `.git/info/exclude`, not
committed.
