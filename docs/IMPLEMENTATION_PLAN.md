# Implementation Plan

Source of truth for requirements: the Master Engineering Specification (sections §1–§138).
Every requirement has an ID in `IMPLEMENTATION_STATUS.md`.

## Phase 0 audit result (2026-09-27)
- Repository `E:\new-project` was **empty** (no code, no git). Nothing to preserve or migrate.
- Dev machine: Windows 11, Node 22.18, npm 10.9, corepack 0.33 (pnpm 9.15 via corepack), Git 2.50,
  MongoDB 8.3 installed (service stopped; used via `mongodb-memory-server` system binary),
  Claude Code CLI 2.1.281 installed. **Not available:** Docker, Redis, Codex/Gemini/OpenCode/Aider CLIs,
  macOS/Linux hosts. These constrain what can be *verified* here (see KNOWN_LIMITATIONS).

## Build order (dependency order)

| Phase | Scope | Depends on |
|---|---|---|
| 0 | Audit, plan, status, architecture, decisions, license decision | — |
| 1 | Monorepo (pnpm+turbo+TS), `core` (errors, ids, redaction, state machines, RBAC, dep graph), `contracts`, `database`, config, logger, API server with auth/orgs/RBAC/audit | 0 |
| 5 | Task engine: create, deps, atomic claim, leases, sweeper, concurrency, worker/agent/model selection, queue | 1 |
| 3 | Agent SDK + runtime (safe spawn, event stream, hang detection) + adapters (mock, claude-code, codex, gemini, opencode, aider) | 1 |
| 4 | Provider SDK + providers (anthropic, openai, google, openrouter, azure-openai, ollama, openai-compatible), health/models/limits | 1 |
| 2 | Worker: config, credential store, pairing, WS client, heartbeat, reconnect/backoff, event buffer, local API + UI, metrics, projects | 1,3,4,5 |
| 6 | Recovery: checkpoints, limit wait, fallback, crash restart, context reset, hung detection, offline recovery | 2,3,5 |
| 9 | Git manager + safety policies | 1 |
| 8 | Verification engine + remediation loop | 2,9 |
| 7 | Capability platform: manifests, registry, scopes, trust, permissions, planner, readiness | 1,2 |
| 10 | Web dashboard (React+Vite) | 1,5 |
| 13 | Docker/Compose, installers, service registration, updater, CLI `agentctl`, doctor | 2 |
| 11 | Mobile (Expo) | 1,10 |
| 12 | Extension points: `extend` composition hook, shared startup | 1 |
| 14 | Integration, E2E, chaos tests; docs verification | all |

Phases 3/4/5 are ordered before the worker (2) because the worker composes them.

## Milestones
- **M1** Control plane boots against MongoDB, register/login/org/project CRUD with RBAC — tested.
- **M2** Task created → claimed atomically by a worker → mock agent runs → events streamed → verified → COMPLETED — integration-tested end to end.
- **M3** Recovery: rate limit → WAITING_FOR_LIMIT → fallback agent; crash restart; context reset; worker death → lease expiry → requeue — tested with the mock agent.
- **M4** Web dashboard usable for daily operation with live updates.
- **M5** Self-hosted deployment artifacts + worker installers + CLI.
- **M6** Capabilities, Git policies, verification with Playwright.
- **M7** Mobile + extension points.
